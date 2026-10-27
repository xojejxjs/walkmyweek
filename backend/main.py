# backend/main.py：BU Dorm Dash 的后端
# 作用：保管 API key（浏览器永远看不到）
#   1. OpenRouteService：替浏览器计算真实步行路线
#   2. Claude（Anthropic）：用户主动点 "Read with AI" 时，替浏览器读课表截图
# 运行方法（在 walkmyweek2 文件夹里）：
#   backend/.venv/bin/python -m uvicorn backend.main:app --reload --port 8001

import base64
import datetime
import json
import logging
import os
import re
import urllib.error
import urllib.request
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# 关掉 uvicorn 的访问日志：它会把每个请求的完整网址（包括起点终点的经纬度，可能是用户现在的位置）
# 打印出来，托管平台会把这些日志存下来。我们不需要这些记录，所以不记
# 错误日志（uvicorn.error）照常保留，出问题时还能排查
logging.getLogger("uvicorn.access").disabled = True

# 创建后端应用。title 会显示在自动生成的接口说明页面（/docs）上
app = FastAPI(title="BU Dorm Dash API")

# CORS：告诉浏览器"这几个网站可以读取我返回的数据"
# 网页（localhost:8000）和后端（localhost:8001）端口不同，浏览器会当成两个网站，默认不允许互相读取
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:8000",       # 本地开发
        "http://127.0.0.1:8000",
        "https://walkmyweek.com",      # 线上网站（自己的域名）
        "https://www.walkmyweek.com",
        "https://xojejxjs.github.io",  # 旧网址：GitHub 会自动跳到新域名，留着以防万一
    ],
    allow_methods=["GET", "POST"],  # 读截图要用 POST（图片太大，放不进网址）
    allow_headers=["Content-Type"],  # 发 JSON 时浏览器会先问一句"可以带这个头吗"
)


# ===== 读取 API key =====

def load_env_file(path):
    """把 .env 文件里的 KEY=VALUE 读进环境变量（已经存在的环境变量优先，不会被覆盖）"""
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip())


# .env 在项目根目录（backend 文件夹的上一层）
load_env_file(Path(__file__).resolve().parent.parent / ".env")
ORS_API_KEY = os.environ.get("ORS_API_KEY")
AI_API_KEY = os.environ.get("AI_API_KEY")
# 用哪个模型：以后想换，改 Render 里的 AI_MODEL 就行，不用改代码
AI_MODEL = os.environ.get("AI_MODEL", "claude-haiku-5-5")

ORS_DIRECTIONS_URL = "https://api.openrouteservice.org/v2/directions/foot-walking/geojson"

# 只接受 BU 周边的坐标，免得别人拿我们的后端去算别的城市，把每天的额度用光
BOSTON_BOUNDS = {"min_lat": 42.30, "max_lat": 42.40, "min_lng": -71.20, "max_lng": -71.00}

# 查过的路线记在这里：key 是四个坐标（保留 5 位小数，约 1 米），value 是结果
route_cache = {}


# ===== 接口 =====

# @app.get(...) 叫"装饰器"：意思是"有人用 GET 方式访问 /api/health 时，执行下面这个函数"
# 函数返回的字典，FastAPI 会自动转成 JSON 发回给浏览器
@app.get("/api/health")
def health():
    # features：这一版后端会做的事。部署以后看这里，就知道 Render 上跑的是不是新版
    #   dates：表头只有日期时，AI 返回 "MM-DD"，由网页推算星期
    return {"status": "ok", "has_api_key": ORS_API_KEY is not None, "has_ai_key": AI_API_KEY is not None,
            "features": ["dates"]}


# 计算两点之间的真实步行路线
# 参数写成 float 类型：FastAPI 会自动检查，不是数字就直接返回错误，不会进到函数里
@app.get("/api/route")
def route(
    from_lat: float = Query(description="起点纬度"),
    from_lng: float = Query(description="起点经度"),
    to_lat: float = Query(description="终点纬度"),
    to_lng: float = Query(description="终点经度"),
):
    # 1. 没有 key：说明 .env 没放好
    if not ORS_API_KEY:
        raise HTTPException(status_code=500, detail="ORS_API_KEY is not set on the server")

    # 2. 坐标不在 BU 周边：拒绝（HTTP 400 表示"请求本身有问题"）
    for lat, lng in [(from_lat, from_lng), (to_lat, to_lng)]:
        if not (BOSTON_BOUNDS["min_lat"] <= lat <= BOSTON_BOUNDS["max_lat"]
                and BOSTON_BOUNDS["min_lng"] <= lng <= BOSTON_BOUNDS["max_lng"]):
            raise HTTPException(status_code=400, detail="Only places near Boston University are supported")

    # 3. 查过的直接返回
    cache_key = tuple(round(v, 5) for v in (from_lat, from_lng, to_lat, to_lng))
    if cache_key in route_cache:
        return route_cache[cache_key]

    # 4. 问 OpenRouteService。注意它要的是 [经度, 纬度]，和我们平时的顺序相反
    body = json.dumps({"coordinates": [[from_lng, from_lat], [to_lng, to_lat]]}).encode()
    request = urllib.request.Request(
        ORS_DIRECTIONS_URL,
        data=body,  # 有 data 就是 POST 请求
        headers={"Authorization": ORS_API_KEY, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            result = json.load(response)
    except urllib.error.HTTPError as error:
        # 路线服务返回了错误（比如额度用完、两点之间走不通）：HTTP 502 表示"我依赖的上游服务出错了"
        raise HTTPException(status_code=502, detail=f"Routing service error ({error.code})")
    except (urllib.error.URLError, TimeoutError):
        raise HTTPException(status_code=502, detail="Routing service unreachable")

    # 5. 整理成前端好用的格式
    feature = result["features"][0]
    summary = feature["properties"]["summary"]
    output = {
        "meters": round(summary.get("distance", 0)),
        "seconds": round(summary.get("duration", 0)),
        # 路线上的每个点，换回 [纬度, 经度]，Leaflet 可以直接用来画线
        "path": [[round(lat, 6), round(lng, 6)] for lng, lat in feature["geometry"]["coordinates"]],
    }
    route_cache[cache_key] = output
    return output


# ===== 用 AI 读课表截图 =====
# 隐私：截图和读出来的课只在这一次请求里用，不存、不打印到日志
# 防刷钱：图片大小有上限；每个 IP 每天、全站每天都有次数上限（记在内存里，后端重启就清零）

ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
MAX_IMAGE_BYTES = 2 * 1024 * 1024   # 浏览器会先把截图缩小，正常只有几百 KB
AI_LIMIT_PER_IP = 10                # 每个 IP 每天几次
AI_LIMIT_TOTAL = 200                # 全站每天几次
ai_usage = {"day": None, "total": 0, "by_ip": {}}

DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

AI_INSTRUCTIONS = """You read screenshots of university class schedules (calendar grids, class detail pop-ups, \
or tables like a course planner's list view) and report every class meeting you can see.

Rules:
- One entry per meeting pattern: the same course, type and time on several days is ONE entry with several days.
  A lecture and a discussion of the same course are separate entries.
- course: the course code exactly as shown, like "CDSDS 210" or "CASWR 120".
- title: the course name if shown, otherwise "".
- type: LEC, DIS, LAB, SEM, IND or similar if shown (for example "A1-LEC" means LEC), otherwise "".
- days: from Mon, Tue, Wed, Thu, Fri, Sat, Sun. In tables grouped under day headings, use the heading above the row.
  In a calendar grid, use the weekday shown on the column heading. Look carefully at which column each block sits in.
  If the headings show only dates (like "Sep 7") and no weekday names, leave days empty and fill dates instead.
  If a heading is cut off and you cannot tell the day, use an empty list.
- dates: only when the column headings show dates without weekday names: every date this meeting appears on,
  as "MM-DD" (for example ["09-07", "09-09"]). Otherwise an empty list.
- start / end: 24-hour "HH:MM". Use "" if not shown.
- room: the location text as shown, including the street address and the building code and room,
  like "685-725 Comm Ave CAS B12" or "CDS 164". Use "" if not shown.
- no_room: true when the schedule says there is no room (for example "-", "TBA", "No room assigned").
- Ignore icons, buttons, instructor names and anything that is not a class meeting.
- If the image is not a class schedule, report an empty list."""

# 用"工具"让 Claude 按固定格式回答：它只能填这张表，不会多说别的话
AI_TOOL = {
    "name": "report_classes",
    "description": "Report the class meetings found in the schedule screenshot.",
    "input_schema": {
        "type": "object",
        "properties": {
            "classes": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "course": {"type": "string"},
                        "title": {"type": "string"},
                        "type": {"type": "string"},
                        "days": {"type": "array", "items": {"type": "string", "enum": DAY_NAMES}},
                        "dates": {"type": "array", "items": {"type": "string"}},
                        "start": {"type": "string"},
                        "end": {"type": "string"},
                        "room": {"type": "string"},
                        "no_room": {"type": "boolean"},
                    },
                    "required": ["course", "days", "start", "end", "room"],
                },
            }
        },
        "required": ["classes"],
    },
}


class ScheduleImage(BaseModel):
    image: str                       # base64，不带 "data:image/jpeg;base64," 开头
    media_type: str = "image/jpeg"


def client_ip(request: Request):
    """用户的 IP：Render 在前面有一层转发，真正的 IP 在 X-Forwarded-For 的第一个"""
    forwarded = request.headers.get("x-forwarded-for", "")
    return forwarded.split(",")[0].strip() or (request.client.host if request.client else "unknown")


def count_ai_use(ip):
    """记一次使用；超过上限就返回 HTTP 429（"请求太多了"）"""
    today = datetime.date.today().isoformat()
    if ai_usage["day"] != today:
        ai_usage.update({"day": today, "total": 0, "by_ip": {}})
    if ai_usage["total"] >= AI_LIMIT_TOTAL or ai_usage["by_ip"].get(ip, 0) >= AI_LIMIT_PER_IP:
        raise HTTPException(status_code=429, detail="Daily AI limit reached")
    ai_usage["total"] += 1
    ai_usage["by_ip"][ip] = ai_usage["by_ip"].get(ip, 0) + 1


def refund_ai_use(ip):
    """AI 那边出错了：这次不算用户的次数"""
    ai_usage["total"] = max(0, ai_usage["total"] - 1)
    ai_usage["by_ip"][ip] = max(0, ai_usage["by_ip"].get(ip, 0) - 1)


def clean_text(value, limit):
    """AI 给的文字：只要字符串，去掉换行，截短"""
    return re.sub(r"\s+", " ", value).strip()[:limit] if isinstance(value, str) else ""


def clean_time(value):
    """只接受 "H:MM" / "HH:MM"，其他的当成没写"""
    match = re.fullmatch(r"(\d{1,2}):(\d{2})", value.strip()) if isinstance(value, str) else None
    if not match or int(match.group(1)) > 23 or int(match.group(2)) > 59:
        return ""
    return f"{int(match.group(1)):02d}:{match.group(2)}"


def clean_classes(raw):
    """检查 AI 的回答，只留下我们要的几项；格式不对的丢掉"""
    classes = []
    for item in raw if isinstance(raw, list) else []:
        if not isinstance(item, dict):
            continue
        course = clean_text(item.get("course"), 20)
        if not course:
            continue
        days = item.get("days") if isinstance(item.get("days"), list) else []
        classes.append({
            "course": course,
            "title": clean_text(item.get("title"), 80),
            "type": clean_text(item.get("type"), 10),
            "days": [d for d in DAY_NAMES if d in days],
            # 表头只有日期时的 "MM-DD"：星期由网页按日期推算（AI 不知道年份，算星期容易错）
            "dates": [d for d in (item.get("dates") if isinstance(item.get("dates"), list) else [])
                      if isinstance(d, str) and re.fullmatch(r"\d{2}-\d{2}", d)][:7],
            "start": clean_time(item.get("start")),
            "end": clean_time(item.get("end")),
            "room": clean_text(item.get("room"), 80),
            "no_room": item.get("no_room") is True,
        })
    return classes[:40]


@app.post("/api/read-schedule")
def read_schedule(body: ScheduleImage, request: Request):
    # 1. 没有 key：Render 的环境变量没放好
    if not AI_API_KEY:
        raise HTTPException(status_code=500, detail="AI_API_KEY is not set on the server")

    # 2. 检查图片：类型、能不能解码、大小
    if body.media_type not in ("image/jpeg", "image/png", "image/webp"):
        raise HTTPException(status_code=400, detail="Unsupported image type")
    try:
        size = len(base64.b64decode(body.image, validate=True))
    except ValueError:
        raise HTTPException(status_code=400, detail="Image is not valid base64")
    if size > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="Image is too large")

    # 3. 次数上限（检查通过才算一次）
    ip = client_ip(request)
    count_ai_use(ip)

    # 4. 问 Claude：一张图 + 说明，强制用 report_classes 这个"表格"回答
    payload = json.dumps({
        "model": AI_MODEL,
        "max_tokens": 2000,
        "system": AI_INSTRUCTIONS,
        "tools": [AI_TOOL],
        "tool_choice": {"type": "tool", "name": "report_classes"},
        "messages": [{
            "role": "user",
            "content": [
                {"type": "image", "source": {"type": "base64", "media_type": body.media_type, "data": body.image}},
                {"type": "text", "text": "Report the class meetings in this schedule screenshot."},
            ],
        }],
    }).encode()
    request_ai = urllib.request.Request(
        ANTHROPIC_URL,
        data=payload,
        headers={
            "x-api-key": AI_API_KEY,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(request_ai, timeout=60) as response:
            result = json.load(response)
    except urllib.error.HTTPError as error:
        # 只记状态码，不记返回的内容（里面可能有课表）
        logging.getLogger("uvicorn.error").warning("AI service error %s", error.code)
        refund_ai_use(ip)
        raise HTTPException(status_code=502, detail=f"AI service error ({error.code})")
    except (urllib.error.URLError, TimeoutError):
        refund_ai_use(ip)
        raise HTTPException(status_code=502, detail="AI service unreachable")

    # 5. 找到 report_classes 的回答，检查格式后返回
    for block in result.get("content", []):
        if block.get("type") == "tool_use" and block.get("name") == "report_classes":
            return {"classes": clean_classes(block.get("input", {}).get("classes"))}
    return {"classes": []}
