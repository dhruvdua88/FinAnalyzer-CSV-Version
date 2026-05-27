from __future__ import annotations

import queue
import threading
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

from tsf_exporter.controller.export_controller import ExportController, ExportRequest


class MainWindow:
    def __init__(self, controller: ExportController) -> None:
        self.controller = controller
        self.root = tk.Tk()
        self.root.title("TSF Exporter")
        self.root.geometry("760x520")
        self.root.minsize(700, 500)

        self.from_var = tk.StringVar()
        self.to_var = tk.StringVar()
        self.out_dir_var = tk.StringVar(value=str(controller.paths.output_dir))
        self.status_var = tk.StringVar(value="Ready")

        self._queue: queue.Queue[tuple[str, str]] = queue.Queue()
        self._build()
        self.root.after(100, self._poll_queue)

    def _build(self) -> None:
        self.root.columnconfigure(0, weight=1)
        self.root.rowconfigure(1, weight=1)

        header = ttk.Frame(self.root, padding=16)
        header.grid(row=0, column=0, sticky="ew")
        header.columnconfigure(0, weight=1)

        title = ttk.Label(header, text="Standalone TSF Exporter", font=("Segoe UI", 16, "bold"))
        title.grid(row=0, column=0, sticky="w")
        subtitle = ttk.Label(
            header,
            text="Runs the bundled loader privately and writes an exact-structure TSF SQLite file.",
        )
        subtitle.grid(row=1, column=0, sticky="w", pady=(6, 0))

        body = ttk.Frame(self.root, padding=(16, 0, 16, 16))
        body.grid(row=1, column=0, sticky="nsew")
        body.columnconfigure(1, weight=1)
        body.rowconfigure(4, weight=1)

        ttk.Label(body, text="From Date (dd/mm/yyyy)").grid(row=0, column=0, sticky="w", pady=(0, 10))
        ttk.Entry(body, textvariable=self.from_var).grid(row=0, column=1, sticky="ew", pady=(0, 10))

        ttk.Label(body, text="To Date (dd/mm/yyyy)").grid(row=1, column=0, sticky="w", pady=(0, 10))
        ttk.Entry(body, textvariable=self.to_var).grid(row=1, column=1, sticky="ew", pady=(0, 10))

        ttk.Label(body, text="Output Folder").grid(row=2, column=0, sticky="w", pady=(0, 10))
        out_row = ttk.Frame(body)
        out_row.grid(row=2, column=1, sticky="ew", pady=(0, 10))
        out_row.columnconfigure(0, weight=1)
        ttk.Entry(out_row, textvariable=self.out_dir_var).grid(row=0, column=0, sticky="ew")
        ttk.Button(out_row, text="Browse", command=self._browse_output_dir).grid(row=0, column=1, padx=(8, 0))

        action_row = ttk.Frame(body)
        action_row.grid(row=3, column=0, columnspan=2, sticky="ew", pady=(0, 12))
        action_row.columnconfigure(0, weight=1)
        self.run_button = ttk.Button(action_row, text="Run Export", command=self._start_export)
        self.run_button.grid(row=0, column=1, sticky="e")

        log_frame = ttk.LabelFrame(body, text="Run Log", padding=8)
        log_frame.grid(row=4, column=0, columnspan=2, sticky="nsew")
        log_frame.columnconfigure(0, weight=1)
        log_frame.rowconfigure(0, weight=1)

        self.log_box = tk.Text(log_frame, wrap="word", state="disabled", font=("Consolas", 10))
        self.log_box.grid(row=0, column=0, sticky="nsew")
        scrollbar = ttk.Scrollbar(log_frame, orient="vertical", command=self.log_box.yview)
        scrollbar.grid(row=0, column=1, sticky="ns")
        self.log_box.configure(yscrollcommand=scrollbar.set)

        status_bar = ttk.Label(self.root, textvariable=self.status_var, anchor="w", padding=(16, 8))
        status_bar.grid(row=2, column=0, sticky="ew")

    def _browse_output_dir(self) -> None:
        selected = filedialog.askdirectory(initialdir=self.out_dir_var.get() or str(Path.home()))
        if selected:
            self.out_dir_var.set(selected)

    def _append_log(self, message: str) -> None:
        self.log_box.configure(state="normal")
        self.log_box.insert("end", f"{message}\n")
        self.log_box.see("end")
        self.log_box.configure(state="disabled")

    def _start_export(self) -> None:
        self.run_button.configure(state="disabled")
        self.status_var.set("Running export...")
        self._append_log("Starting export...")

        request = ExportRequest(
            from_date=self.from_var.get(),
            to_date=self.to_var.get(),
            out_dir=Path(self.out_dir_var.get()).expanduser(),
        )

        def worker() -> None:
            try:
                result = self.controller.run_export_sync(request, progress_callback=self._threadsafe_log)
                self._queue.put(("done", f"Export created: {result.output_path}\nLog file: {result.log_path}"))
            except Exception as exc:
                self._queue.put(("error", str(exc)))

        threading.Thread(target=worker, daemon=True).start()

    def _threadsafe_log(self, message: str) -> None:
        self._queue.put(("log", message))

    def _poll_queue(self) -> None:
        while True:
            try:
                kind, payload = self._queue.get_nowait()
            except queue.Empty:
                break

            if kind == "log":
                self.status_var.set(payload)
                self._append_log(payload)
            elif kind == "done":
                self.status_var.set("Completed")
                self.run_button.configure(state="normal")
                self._append_log(payload)
                messagebox.showinfo("TSF Exporter", payload)
            elif kind == "error":
                self.status_var.set("Failed")
                self.run_button.configure(state="normal")
                self._append_log(f"ERROR: {payload}")
                messagebox.showerror("TSF Exporter", payload)

        self.root.after(100, self._poll_queue)

    def run(self) -> None:
        self.root.mainloop()


def launch_main_window(controller: ExportController) -> None:
    MainWindow(controller).run()
