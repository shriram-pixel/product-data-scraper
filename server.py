"""
Product Scraper - FastAPI server.

Run:  python server.py          (then open http://127.0.0.1:8001)
  or: uvicorn server:app --reload

Unlike the Vercel version, this is a normal long-running server, so Python
writes the folder straight to disk. The browser is only the UI, which is why
this works in Firefox and Safari: nothing is asked of the browser beyond
showing a progress log. No folder picker, no archive.
"""

import os
import threading
import subprocess
from uuid import uuid4

from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

import scraper

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
INDEX = os.path.join(BASE_DIR, "static", "index.html")

app = FastAPI(title="Product Scraper")

# job_id -> job state. In-memory on purpose: jobs are per-run and disposable.
jobs = {}
jobs_lock = threading.Lock()


class ScrapeRequest(BaseModel):
    site: str
    collection: str = ""


class Job:
    def __init__(self, site, collection, output_dir):
        self.id = uuid4().hex[:12]
        self.site = site
        self.collection = collection
        self.output_dir = output_dir
        self.status = "running"        # running | done | stopped | failed
        self.lines = []
        self.folder = None
        self.error = None
        self.stop_flag = threading.Event()
        self.lock = threading.Lock()

    def log(self, text):
        with self.lock:
            # scraper.py emits leading newlines for spacing; keep one line per entry
            for line in str(text).split("\n"):
                self.lines.append(line)

    def snapshot(self, since=0):
        with self.lock:
            return {
                "id": self.id,
                "status": self.status,
                "folder": self.folder,
                "error": self.error,
                "cursor": len(self.lines),
                "lines": self.lines[since:],
            }


def run_job(job: Job):
    try:
        job.folder = scraper.scrape(
            job.site,
            job.collection,
            job.output_dir,
            log=job.log,
            should_stop=job.stop_flag.is_set,
        )
        job.status = "stopped" if job.stop_flag.is_set() else "done"
    except Exception as e:
        job.error = str(e)
        job.status = "failed"
        job.log(f"\nERROR: {e}")


@app.get("/", response_class=HTMLResponse)
def index():
    with open(INDEX, encoding="utf-8") as f:
        return f.read()


@app.get("/api/defaults")
def defaults():
    return {"output_dir": scraper.desktop_dir()}


@app.post("/api/scrape")
def start_scrape(req: ScrapeRequest):
    try:
        scraper.normalise_site(req.site)          # fail fast on a bad link
    except ValueError as e:
        raise HTTPException(400, str(e))

    # Always the Desktop: the whole point of this server is that nothing has
    # to be chosen, so there is no output_dir to pass in.
    output_dir = scraper.desktop_dir()
    try:
        os.makedirs(output_dir, exist_ok=True)
    except OSError as e:
        raise HTTPException(400, f"Cannot write to the Desktop: {e}")

    job = Job(req.site, req.collection, output_dir)
    with jobs_lock:
        jobs[job.id] = job

    threading.Thread(target=run_job, args=(job,), daemon=True).start()
    return {"job_id": job.id}


def get_job(job_id) -> Job:
    with jobs_lock:
        job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Unknown job.")
    return job


@app.get("/api/jobs/{job_id}")
def job_status(job_id: str, since: int = 0):
    return get_job(job_id).snapshot(since)


@app.post("/api/jobs/{job_id}/stop")
def stop_job(job_id: str):
    job = get_job(job_id)
    job.stop_flag.set()
    job.log("\nStop requested - finishing the current download...")
    return {"ok": True}


@app.post("/api/jobs/{job_id}/open")
def open_folder(job_id: str):
    """Convenience for the common case: server and browser on the same PC."""
    job = get_job(job_id)
    if not job.folder or not os.path.isdir(job.folder):
        raise HTTPException(404, "No folder yet.")
    if os.name == "nt":
        os.startfile(job.folder)                  # noqa: S606 - Windows only
    else:
        subprocess.Popen(["xdg-open", job.folder])
    return {"ok": True}


if __name__ == "__main__":
    import uvicorn

    print("Product Scraper -> http://127.0.0.1:8001")
    uvicorn.run(app, host="127.0.0.1", port=8001)
