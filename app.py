"""
Product Scraper - desktop UI.

Run:  python app.py

Paste a store link, optionally a collection name, press Start. A folder
named after the site is created on the Desktop, holding images/ +
products.xlsx + products.csv. Nothing to choose and nothing to unzip.
"""

import os
import queue
import threading
import subprocess
import tkinter as tk
from tkinter import ttk, messagebox

import scraper


def desktop_dir():
    """
    The real Desktop, which is not always ~/Desktop: OneDrive backup moves it
    to ~/OneDrive/Desktop and leaves the old path behind, so ask Windows where
    it actually is before guessing.
    """
    if os.name == "nt":
        try:
            import winreg

            key = winreg.OpenKey(
                winreg.HKEY_CURRENT_USER,
                r"Software\Microsoft\Windows\CurrentVersion\Explorer\Shell Folders",
            )
            with key:
                path, _ = winreg.QueryValueEx(key, "Desktop")
            if path and os.path.isdir(path):
                return path
        except OSError:
            pass

    home = os.path.expanduser("~")
    for candidate in (
        os.path.join(home, "Desktop"),
        os.path.join(home, "OneDrive", "Desktop"),
    ):
        if os.path.isdir(candidate):
            return candidate
    return home


class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Product Scraper")
        self.geometry("820x600")
        self.minsize(680, 480)

        self.log_queue = queue.Queue()
        self.worker = None
        self.stop_flag = threading.Event()
        self.last_folder = None

        self._build_ui()
        self.after(100, self._drain_log)
        self.protocol("WM_DELETE_WINDOW", self._on_close)

    # ------------------------------------------------------------------ ui
    def _build_ui(self):
        pad = {"padx": 10, "pady": 6}
        form = ttk.Frame(self)
        form.pack(fill="x", **pad)
        form.columnconfigure(1, weight=1)

        ttk.Label(form, text="Website link *").grid(row=0, column=0, sticky="w")
        self.site_var = tk.StringVar()
        ttk.Entry(form, textvariable=self.site_var).grid(
            row=0, column=1, columnspan=2, sticky="ew", padx=(8, 0), pady=4
        )

        ttk.Label(form, text="Collection / page").grid(row=1, column=0, sticky="w")
        self.coll_var = tk.StringVar()
        ttk.Entry(form, textvariable=self.coll_var).grid(
            row=1, column=1, columnspan=2, sticky="ew", padx=(8, 0), pady=4
        )
        ttk.Label(
            form,
            text="leave empty to scrape every product on the store",
            foreground="#666",
        ).grid(row=2, column=1, sticky="w", padx=(8, 0))

        ttk.Label(form, text="Saves to").grid(row=3, column=0, sticky="w", pady=(8, 0))
        ttk.Label(
            form,
            text=os.path.join(desktop_dir(), "<website name>"),
            foreground="#666",
        ).grid(row=3, column=1, columnspan=2, sticky="w", padx=(8, 0), pady=(8, 0))

        bar = ttk.Frame(self)
        bar.pack(fill="x", padx=10)
        self.start_btn = ttk.Button(bar, text="Start scraping", command=self._start)
        self.start_btn.pack(side="left")
        self.stop_btn = ttk.Button(
            bar, text="Stop", command=self._stop, state="disabled"
        )
        self.stop_btn.pack(side="left", padx=6)
        self.open_btn = ttk.Button(
            bar, text="Open folder", command=self._open_folder, state="disabled"
        )
        self.open_btn.pack(side="left")

        self.status = ttk.Label(bar, text="Ready", foreground="#666")
        self.status.pack(side="right")

        self.progress = ttk.Progressbar(self, mode="indeterminate")
        self.progress.pack(fill="x", padx=10, pady=(8, 0))

        log_frame = ttk.Frame(self)
        log_frame.pack(fill="both", expand=True, padx=10, pady=10)
        self.log = tk.Text(log_frame, wrap="none", height=20, bg="#111", fg="#ddd")
        self.log.pack(side="left", fill="both", expand=True)
        sb = ttk.Scrollbar(log_frame, command=self.log.yview)
        sb.pack(side="right", fill="y")
        self.log.configure(yscrollcommand=sb.set, state="disabled")

    # ------------------------------------------------------------- logging
    def _write(self, text):
        self.log_queue.put(text)

    def _drain_log(self):
        """Text widget updates must happen on the Tk thread, so the worker
        pushes lines onto a queue and this pump drains it."""
        try:
            while True:
                line = self.log_queue.get_nowait()
                self.log.configure(state="normal")
                self.log.insert("end", line + "\n")
                self.log.see("end")
                self.log.configure(state="disabled")
        except queue.Empty:
            pass
        self.after(100, self._drain_log)

    # ----------------------------------------------------------- run / stop
    def _start(self):
        site = self.site_var.get().strip()
        out_dir = desktop_dir()

        if not site:
            messagebox.showwarning("Missing link", "Paste the website link first.")
            return

        try:
            os.makedirs(out_dir, exist_ok=True)
        except OSError as e:
            messagebox.showerror("Folder error", f"Cannot write to the Desktop:\n{e}")
            return

        self.log.configure(state="normal")
        self.log.delete("1.0", "end")
        self.log.configure(state="disabled")

        self.stop_flag.clear()
        self.start_btn.configure(state="disabled")
        self.stop_btn.configure(state="normal")
        self.open_btn.configure(state="disabled")
        self.status.configure(text="Working...")
        self.progress.start(12)

        self.worker = threading.Thread(
            target=self._run, args=(site, self.coll_var.get(), out_dir), daemon=True
        )
        self.worker.start()

    def _run(self, site, collection, out_dir):
        folder, error = None, None
        try:
            folder = scraper.scrape(
                site, collection, out_dir,
                log=self._write, should_stop=self.stop_flag.is_set,
            )
        except Exception as e:
            error = str(e)
            self._write(f"\nERROR: {e}")
        self.after(0, self._finish, folder, error)

    def _finish(self, folder, error):
        self.progress.stop()
        self.start_btn.configure(state="normal")
        self.stop_btn.configure(state="disabled")

        if folder:
            self.last_folder = folder
            self.open_btn.configure(state="normal")
            self.status.configure(
                text="Stopped" if self.stop_flag.is_set() else "Done"
            )
        else:
            self.status.configure(text="Failed")
            if error:
                messagebox.showerror("Scrape failed", error)

    def _stop(self):
        self.stop_flag.set()
        self.status.configure(text="Stopping...")
        self._write("\nStop requested - finishing the current download...")

    def _open_folder(self):
        if self.last_folder and os.path.isdir(self.last_folder):
            if os.name == "nt":
                os.startfile(self.last_folder)          # noqa: S606 - Windows only
            else:
                subprocess.Popen(["xdg-open", self.last_folder])

    def _on_close(self):
        if self.worker and self.worker.is_alive():
            if not messagebox.askokcancel("Quit", "A scrape is running. Quit anyway?"):
                return
            self.stop_flag.set()
        self.destroy()


if __name__ == "__main__":
    App().mainloop()
