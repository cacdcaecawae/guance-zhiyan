"""本机 BGE-M3 向量服务，兼容 server/rag-embedding.ts 使用的 OpenAI /embeddings 协议。

用法：BGE_M3_DIR=<BAAI/bge-m3 模型目录> python server/rag/embed-server.py [端口，默认 8081]
自检（不需要模型与 torch）：python server/rag/embed-server.py --self-check
依赖：torch（有 NVIDIA 显卡时装对应 CUDA 版）、transformers。模型需事先下载，本项目不自动下载。
后端配置：EMBEDDING_URL=http://127.0.0.1:8081/embeddings EMBEDDING_MODEL=bge-m3 EMBEDDING_DIMENSIONS=1024
模型名默认 bge-m3，请求里的 model 不同时返回 400；后端用别的名字时，启动本服务前设同名环境变量 EMBEDDING_MODEL。
只取稠密向量（CLS + L2 归一化，与 BGE-M3 官方 dense 用法一致），不做稀疏 / 多向量。只监听 127.0.0.1。
"""
import gc, json, os, sys, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DIMENSIONS = 1024
# BGE-M3 支持的最长输入。片段最长 1600 字，通常远短于此；但 OCR 杂字、少见符号、长网址按字节拆分时
# 词元数可能超过字数，按字数估计的较小上限会悄悄截掉片段后半部分
MAX_TOKENS = 8192
MAX_INPUTS = 256
# 请求体上限，读取前按 Content-Length 检查（本机任一进程都能连上本服务）。每条最多 MAX_TOKENS 词元，
# 一个词元常为 1–2 个汉字，JSON 里每字 3 字节（转义写法时 6 字节），按每词元 16 字节估，共 32 MiB；
# 网站实际每批 32 条、每条不超过 1600 字，约 150 KB
MAX_BODY = MAX_INPUTS * MAX_TOKENS * 16
# 本服务的模型名，须与 server/.env 的 EMBEDDING_MODEL 一致：索引按这个名字记录用的是哪个模型，名字对不上的请求一律拒绝
MODEL = os.environ.get("EMBEDDING_MODEL") or "bge-m3"


def model_ok(body):
    """请求的 model 与本服务一致（不带 model 视为一致）。"""
    return body.get("model", MODEL) == MODEL


def body_length(value):
    """Content-Length 头 → 字节数。缺失或不是非负整数时抛 ValueError（400），超过 MAX_BODY 时抛 OverflowError（413）。"""
    if value is None or not (value.isascii() and value.isdigit()):
        raise ValueError("缺少 Content-Length，或不是非负整数")
    if int(value) > MAX_BODY:
        raise OverflowError(f"请求体超过 {MAX_BODY} 字节")
    return int(value)


if sys.argv[1:] == ["--self-check"]:
    assert model_ok({"model": MODEL}) and model_ok({}) and not model_ok({"model": MODEL + "-x"}), "模型名不符未被拒绝"
    assert body_length("0") == 0 and body_length(str(MAX_BODY)) == MAX_BODY
    for bad in (None, "", "-1", "1e3", "+5", " 5", "²"):
        try:
            body_length(bad)
        except ValueError:
            continue
        raise AssertionError(f"Content-Length {bad!r} 未被拒绝")
    try:
        body_length(str(MAX_BODY + 1))
    except OverflowError:
        sys.exit(print("embed-server 自检通过"))
    raise AssertionError("超过上限的 Content-Length 未被拒绝")

MODEL_DIR = os.environ.get("BGE_M3_DIR")
if not MODEL_DIR or not os.path.isdir(MODEL_DIR):
    sys.exit("请用环境变量 BGE_M3_DIR 指定已下载的 BAAI/bge-m3 模型目录。")

import torch
from transformers import AutoModel, AutoTokenizer

device = "cuda" if torch.cuda.is_available() else "cpu"
tokenizer = AutoTokenizer.from_pretrained(MODEL_DIR)
# 移到显卡后回收 CPU 侧副本，降低提交内存（low_cpu_mem_usage 需另装 accelerate，未采用）
model = AutoModel.from_pretrained(MODEL_DIR, torch_dtype=torch.float16 if device == "cuda" else torch.float32).to(device).eval()
gc.collect()
lock = threading.Lock()  # 单 GPU，串行推理
# 显存用满时 Windows 驱动会把显存溢出到系统内存（计入提交内存、极慢，曾导致系统内存耗尽）。
# 限制 PyTorch 显存上限，超出时报 OOM 而不是溢出；请求内按长度排序后分小批推理，OOM 时小批减半重试。
MICRO_BATCH = int(os.environ.get("EMBED_MICRO_BATCH", "8"))
if device == "cuda":
    torch.cuda.set_per_process_memory_fraction(float(os.environ.get("EMBED_GPU_FRACTION", "0.8")))


@torch.inference_mode()
def encode(texts):
    batch = tokenizer(texts, padding=True, truncation=True, max_length=MAX_TOKENS, return_tensors="pt").to(device)
    cls = model(**batch).last_hidden_state[:, 0]
    return torch.nn.functional.normalize(cls.float(), dim=-1).cpu().tolist()


def embed(texts):
    order = sorted(range(len(texts)), key=lambda i: len(texts[i]))
    out = [None] * len(texts)
    size, i = MICRO_BATCH, 0
    while i < len(order):
        part = order[i : i + size]
        try:
            vectors = encode([texts[j] for j in part])
        except torch.cuda.OutOfMemoryError:
            torch.cuda.empty_cache()
            if size == 1:
                raise
            size //= 2
            continue
        for j, v in zip(part, vectors):
            out[j] = v
        i += len(part)
    return out


class Handler(BaseHTTPRequestHandler):
    def reply(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        if self.path.rstrip("/") not in ("/embeddings", "/v1/embeddings"):
            return self.reply(404, {"error": "not found"})
        try:
            length = body_length(self.headers.get("Content-Length"))
        except OverflowError as error:
            return self.reply(413, {"error": str(error)})
        except ValueError as error:
            return self.reply(400, {"error": str(error)})
        try:
            body = json.loads(self.rfile.read(length))
            texts = body["input"]
            if isinstance(texts, str):
                texts = [texts]
            if not (isinstance(texts, list) and 0 < len(texts) <= MAX_INPUTS and all(isinstance(t, str) and t.strip() for t in texts)):
                raise ValueError("input 须为 1–256 条非空文本")
            if body.get("dimensions", DIMENSIONS) != DIMENSIONS:
                raise ValueError(f"BGE-M3 只支持 {DIMENSIONS} 维")
            if not model_ok(body):
                raise ValueError(f"本服务的模型名是 {MODEL}，请求的是 {body.get('model')!r}，请核对 EMBEDDING_MODEL")
        except (ValueError, KeyError, TypeError, json.JSONDecodeError) as error:
            return self.reply(400, {"error": str(error)})
        try:
            with lock:
                vectors = embed(texts)
        except Exception as error:  # 推理失败（如显存不足）明确返回 500，而不是直接断开连接
            return self.reply(500, {"error": f"向量计算失败：{type(error).__name__}"})
        self.reply(200, {"object": "list", "model": MODEL, "data": [{"object": "embedding", "index": i, "embedding": v} for i, v in enumerate(vectors)]})

    def log_message(self, *args):
        pass


port = int(sys.argv[1]) if len(sys.argv) > 1 else 8081
print(f"BGE-M3 on {device}, http://127.0.0.1:{port}/embeddings", flush=True)
ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
