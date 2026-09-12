#!/usr/bin/env python3
"""Download a PDF (or HTML) and dump extracted text. Usage: pdfgrab.py URL [outfile] [--grep PATTERN]"""
import sys, subprocess, re, io

def fetch(url, out):
    r = subprocess.run(["curl", "-sS", "-L", "--max-time", "120",
                        "-A", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
                        "-o", out, "-w", "%{http_code} %{content_type}", url],
                       capture_output=True, text=True)
    return r.stdout.strip(), r.stderr.strip()

def pdftext(path):
    import logging, warnings
    logging.getLogger("pypdf").setLevel(logging.CRITICAL)
    warnings.filterwarnings("ignore")
    from pypdf import PdfReader
    reader = PdfReader(path)
    chunks = []
    for i, page in enumerate(reader.pages):
        try:
            t = page.extract_text() or ""
        except Exception as e:
            t = f"[extract error page {i}: {e}]"
        chunks.append(f"\n===== PAGE {i+1} =====\n{t}")
    return "".join(chunks)

url = sys.argv[1]
out = sys.argv[2] if len(sys.argv) > 2 and not sys.argv[2].startswith("--") else "/tmp/grab.bin"
pat = None
if "--grep" in sys.argv:
    pat = sys.argv[sys.argv.index("--grep") + 1]

status, err = fetch(url, out)
print(f"### FETCH {url}\n### status={status} err={err}")
with open(out, "rb") as f:
    head = f.read(5)
if head.startswith(b"%PDF"):
    text = pdftext(out)
else:
    text = open(out, "r", errors="replace").read()
    # crude html strip
    text = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", text)
    text = re.sub(r"(?s)<[^>]+>", " ", text)
    text = re.sub(r"&nbsp;", " ", text)
    text = re.sub(r"&amp;", "&", text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n\s*\n+", "\n\n", text)
print(text)
