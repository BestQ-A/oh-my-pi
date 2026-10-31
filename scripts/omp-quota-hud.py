#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
OMP Coding Plans Standalone Desktop Floating HUD (Windows 10/11, Python 3.12 stdlib).

Features:
- Per-Monitor v2 DPI awareness (`SetProcessDpiAwarenessContext(-4)` with fallbacks)
  and monitor-aware scaling across 2K / 4K mixed-DPI setups.
- Single-instance localhost TCP control socket (`~/.omp/cache/omp-quota-hud.json`):
  `--open` (default), `--toggle`, `--mini`, `--full`, `--refresh`, `--close`, `--status`.
- Two instant-switch frameless dark modes:
  1. `--mini`: Compact horizontal Coding Plan capsule strip (`AG 85%·3h | GLM 97%·3h | ...`).
  2. `--full`: Multi-pool dashboard with live 1-second reset countdowns, smooth canvas
     progress bars, `✦N 重置券` & `🔥 临期优先` badges, and surgical comment-preserving
     `~/.omp/agent/config.yml` `modelPresets` hot-switching.
- Safe under `pythonw.exe` where `sys.stdout` / `sys.stderr` are `None`.
"""

from __future__ import annotations

import argparse
import ctypes
import ctypes.wintypes as wintypes
import json
import math
import os
import queue
import re
import secrets
import shutil
import socket
import subprocess
import sys
import threading
import time
import traceback
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any

# Guard None stdio streams immediately so pythonw.exe never raises AttributeError on write/flush.
_HAS_REAL_STDOUT = sys.stdout is not None
_HAS_REAL_STDERR = sys.stderr is not None
if sys.stdout is None:
    sys.stdout = open(os.devnull, "w", encoding="utf-8")
if sys.stderr is None:
    sys.stderr = open(os.devnull, "w", encoding="utf-8")

if TYPE_CHECKING:
    import tkinter as tk
else:
    tk: Any = None


# ─── Paths & Constants ────────────────────────────────────────────────────────

HOME_DIR = Path.home()
OMP_DIR = HOME_DIR / ".omp"
CACHE_DIR = OMP_DIR / "cache"
AGENT_DIR = OMP_DIR / "agent"

USAGE_CACHE_PATH = CACHE_DIR / "finops-live-usage.json"
SOCKET_STATE_PATH = CACHE_DIR / "omp-quota-hud.json"
UI_STATE_PATH = CACHE_DIR / "omp-quota-hud-ui.json"
LEGACY_PID_PATH = CACHE_DIR / "quota-popup.pid"
LOG_PATH = CACHE_DIR / "omp-quota-hud.log"
CONFIG_YML_PATH = AGENT_DIR / "config.yml"

AUTO_REFRESH_MAX_AGE_MS = 5 * 60 * 1000  # 5 minutes
AUTO_REFRESH_RETRY_COOLDOWN_MS = 60 * 1000
EXPIRING_WINDOW_MS = 6 * 3600 * 1000  # < 6h
EXPIRING_MIN_REMAINING_PCT = 15.0  # > 15%

# Dark Obsidian / Slate Palette
THEME = {
    "border": "#1e3352",
    "border_active": "#2b4c7e",
    "bg": "#0b1220",
    "header_bg": "#0f172a",
    "sub_bg": "#0d1628",
    "card_bg": "#111c2e",
    "card_exhausted_bg": "#0d1523",
    "card_border": "#1c2d46",
    "card_expiring_border": "#92400e",
    "divider": "#1b2a42",
    "btn_bg": "#16243a",
    "btn_hover": "#213656",
    "btn_active_bg": "#0c2d48",
    "btn_active_border": "#0ea5e9",
    "btn_close_hover": "#7f1d1d",
    "track_bg": "#18263b",
    "text_primary": "#f1f5f9",
    "text_secondary": "#94a3b8",
    "text_muted": "#64748b",
    "cyan": "#38bdf8",
    "cyan_bg": "#0a2740",
    "emerald": "#10b981",
    "emerald_text": "#34d399",
    "emerald_bg": "#072922",
    "emerald_border": "#0f5132",
    "amber": "#f59e0b",
    "amber_text": "#fbbf24",
    "amber_bg": "#2e1f07",
    "amber_border": "#78350f",
    "orange": "#f97316",
    "orange_text": "#fb923c",
    "orange_bg": "#2d160a",
    "orange_border": "#7c2d12",
    "rose": "#ef4444",
    "rose_text": "#f87171",
    "rose_bg": "#251119",
    "rose_border": "#581c28",
}

PROVIDER_CATALOG: dict[str, dict[str, Any]] = {
    "google-antigravity": {"short": "AG", "name": "Antigravity", "order": 1},
    "zhipu-coding-plan": {"short": "GLM", "name": "Zhipu GLM Coding", "order": 2},
    "minimax-code": {"short": "MM", "name": "MiniMax Code", "order": 3},
    "openai-codex": {"short": "CDX", "name": "OpenAI Codex", "order": 4},
    "cursor": {"short": "CUR", "name": "Cursor", "order": 5},
    "devin": {"short": "DEV", "name": "Devin", "order": 6},
    "anthropic": {"short": "CLD", "name": "Claude", "order": 7},
    "github-copilot": {"short": "COP", "name": "GitHub Copilot", "order": 8},
}


# ─── Logging & Atomic File Helpers ────────────────────────────────────────────


def log_debug(msg: str) -> None:
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        if LOG_PATH.exists() and LOG_PATH.stat().st_size > 65536:
            try:
                LOG_PATH.unlink()
            except OSError:
                pass
        stamp = time.strftime("%Y-%m-%d %H:%M:%S")
        with LOG_PATH.open("a", encoding="utf-8") as fh:
            fh.write(f"[{stamp}] [pid={os.getpid()}] {msg}\n")
    except Exception:
        pass


def atomic_write_text(target: Path, content: str, encoding: str = "utf-8") -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = target.with_name(f"{target.name}.hud-{os.getpid()}-{secrets.token_hex(3)}.tmp")
    with tmp_path.open("w", encoding=encoding, newline="") as fh:
        fh.write(content)
        fh.flush()
        os.fsync(fh.fileno())
    last_err: Exception | None = None
    for attempt in range(6):
        try:
            os.replace(tmp_path, target)
            return
        except PermissionError as err:
            last_err = err
            time.sleep(0.015 * (attempt + 1))
    try:
        if tmp_path.exists():
            tmp_path.unlink()
    except OSError:
        pass
    if last_err is not None:
        raise last_err


def read_json_file(path: Path) -> dict[str, Any] | None:
    try:
        if not path.exists():
            return None
        raw = path.read_text(encoding="utf-8")
        data = json.loads(raw)
        return data if isinstance(data, dict) else None
    except Exception:
        return None


# ─── Win32 Per-Monitor v2 DPI & Window Helpers ────────────────────────────────


class _MONITORINFO(ctypes.Structure):
    _fields_ = [
        ("cbSize", wintypes.DWORD),
        ("rcMonitor", wintypes.RECT),
        ("rcWork", wintypes.RECT),
        ("dwFlags", wintypes.DWORD),
    ]


def enable_per_monitor_dpi() -> str:
    if sys.platform != "win32":
        return "non-win32"
    user32 = ctypes.windll.user32
    # 1. Per-Monitor v2: DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = (DPI_AWARENESS_CONTEXT)-4
    try:
        set_ctx = user32.SetProcessDpiAwarenessContext
        set_ctx.argtypes = [ctypes.c_void_p]
        set_ctx.restype = wintypes.BOOL
        if set_ctx(ctypes.c_void_p(-4)):
            return "per-monitor-v2"
    except Exception:
        pass
    # 2. Per-Monitor v1 via shcore
    try:
        if ctypes.windll.shcore.SetProcessDpiAwareness(2) == 0:
            return "per-monitor-v1"
    except Exception:
        pass
    # 3. System DPI aware fallback
    try:
        user32.SetProcessDPIAware()
        return "system-dpi"
    except Exception:
        return "unaware"


def get_monitor_dpi_and_workarea(x: int, y: int) -> tuple[int, tuple[int, int, int, int]]:
    """Return `(dpi, (work_left, work_top, work_right, work_bottom))` for point `(x, y)`."""
    if sys.platform != "win32":
        return 96, (0, 0, 1920, 1040)
    user32 = ctypes.windll.user32
    try:
        user32.MonitorFromPoint.argtypes = [wintypes.POINT, wintypes.DWORD]
        user32.MonitorFromPoint.restype = wintypes.HANDLE
        hmon = user32.MonitorFromPoint(wintypes.POINT(int(x), int(y)), 2)  # MONITOR_DEFAULTTONEAREST
        mi = _MONITORINFO()
        mi.cbSize = ctypes.sizeof(_MONITORINFO)
        work = (0, 0, user32.GetSystemMetrics(0), user32.GetSystemMetrics(1) - 48)
        if hmon and user32.GetMonitorInfoW(hmon, ctypes.byref(mi)):
            work = (mi.rcWork.left, mi.rcWork.top, mi.rcWork.right, mi.rcWork.bottom)
        dpi_x = ctypes.c_uint(96)
        dpi_y = ctypes.c_uint(96)
        try:
            if hmon and ctypes.windll.shcore.GetDpiForMonitor(hmon, 0, ctypes.byref(dpi_x), ctypes.byref(dpi_y)) == 0:
                return max(72, int(dpi_x.value)), work
        except Exception:
            pass
        try:
            sys_dpi = int(user32.GetDpiForSystem())
            if sys_dpi >= 72:
                return sys_dpi, work
        except Exception:
            pass
        return 96, work
    except Exception:
        return 96, (0, 0, 1920, 1040)


def get_virtual_screen_bounds() -> tuple[int, int, int, int]:
    if sys.platform != "win32":
        return (0, 0, 1920, 1080)
    u = ctypes.windll.user32
    vx = u.GetSystemMetrics(76)
    vy = u.GetSystemMetrics(77)
    vw = u.GetSystemMetrics(78)
    vh = u.GetSystemMetrics(79)
    if vw <= 0 or vh <= 0:
        return (0, 0, u.GetSystemMetrics(0), u.GetSystemMetrics(1))
    return (vx, vy, vx + vw, vy + vh)


def apply_win11_window_chrome(hwnd: int) -> None:
    """Apply subtle Windows 11 DWM rounded corners on frameless HUD window."""
    if sys.platform != "win32" or not hwnd:
        return
    try:
        dwmapi = ctypes.windll.dwmapi
        # DWMWA_WINDOW_CORNER_PREFERENCE = 33, DWMWCP_ROUNDSMALL = 3
        pref = ctypes.c_int(3)
        dwmapi.DwmSetWindowAttribute(
            wintypes.HWND(hwnd),
            wintypes.DWORD(33),
            ctypes.byref(pref),
            ctypes.sizeof(pref),
        )
    except Exception:
        pass


def terminate_legacy_quota_popup_if_requested() -> bool:
    """Gracefully stop legacy `quota-popup.pid` ONLY when `--replace-legacy` is passed."""
    if not LEGACY_PID_PATH.exists():
        return False
    try:
        raw_pid = LEGACY_PID_PATH.read_text(encoding="utf-8").strip()
        pid = int(raw_pid)
    except Exception:
        return False

    if pid <= 0 or pid == os.getpid():
        return False

    terminated = False
    if sys.platform == "win32":
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        PROCESS_TERMINATE = 0x0001
        kernel32 = ctypes.windll.kernel32
        hproc = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE, False, pid)
        if hproc:
            try:
                buf = ctypes.create_unicode_buffer(1024)
                size = wintypes.DWORD(1024)
                if kernel32.QueryFullProcessImageNameW(hproc, 0, buf, ctypes.byref(size)):
                    exe_name = Path(buf.value).name.lower()
                    if exe_name in ("python.exe", "pythonw.exe"):
                        kernel32.TerminateProcess(hproc, 0)
                        terminated = True
            finally:
                kernel32.CloseHandle(hproc)
    try:
        LEGACY_PID_PATH.unlink(missing_ok=True)
    except OSError:
        pass
    return terminated


# ─── Usage Cache Normalization Engine ─────────────────────────────────────────


@dataclass
class WindowRowData:
    limit_id: str
    display_label: str
    window_id: str
    duration_ms: int
    resets_at_ms: int | None
    remaining_frac: float
    remaining_pct: float
    is_auxiliary: bool
    detail_suffix: str = ""

    def is_expiring_priority(self, now_ms: int) -> bool:
        if self.remaining_pct <= EXPIRING_MIN_REMAINING_PCT:
            return False
        if not self.resets_at_ms or self.resets_at_ms <= now_ms:
            return False
        return (self.resets_at_ms - now_ms) < EXPIRING_WINDOW_MS


@dataclass
class PoolCardData:
    provider: str
    short_tag: str
    provider_name: str
    provider_order: int
    account_subtitle: str
    primary_pct: float
    primary_resets_at_ms: int | None
    reset_credits: int
    windows: list[WindowRowData] = field(default_factory=list)

    def has_expiring_priority(self, now_ms: int) -> bool:
        return any(w.is_expiring_priority(now_ms) for w in self.windows if not w.is_auxiliary) or any(
            w.is_expiring_priority(now_ms) for w in self.windows
        )


@dataclass
class ProviderPillData:
    provider: str
    short_tag: str
    provider_order: int
    remaining_pct: float
    resets_at_ms: int | None
    reset_credits: int
    account_remaining_pcts: tuple[int, ...] = ()

    def format_text(self, now_ms: int, show_left: bool = True) -> str:
        pol = "余" if show_left else "用"
        if len(self.account_remaining_pcts) > 1:
            shown_vals = [p if show_left else max(0, 100 - p) for p in self.account_remaining_pcts[:3]]
            joined = "/".join(f"{v}%" for v in shown_vals)
            if len(self.account_remaining_pcts) > 3:
                joined += f"+{len(self.account_remaining_pcts) - 3}"
            base = f"{self.short_tag} {pol}{joined}"
        else:
            pct_int = int(round(self.remaining_pct if show_left else max(0.0, 100.0 - self.remaining_pct)))
            base = f"{self.short_tag} {pol}{pct_int}%"
        # Append compact reset window (`·3h` / `·42m`) when active pool is <100% and resets within 24h
        if 0 < self.remaining_pct < 99.95 and self.resets_at_ms and self.resets_at_ms > now_ms:
            rem_sec = int((self.resets_at_ms - now_ms) // 1000)
            if 0 < rem_sec < 86400:
                if rem_sec >= 3600:
                    base += f"·{rem_sec // 3600}h"
                else:
                    base += f"·{max(1, rem_sec // 60)}m"
        if self.reset_credits > 0:
            base += f"✦{self.reset_credits}"
        return base

@dataclass
class UsageSnapshot:
    generated_at_ms: int = 0
    cards: list[PoolCardData] = field(default_factory=list)
    pills: list[ProviderPillData] = field(default_factory=list)
    providers: list[str] = field(default_factory=list)


def _finite_float(val: Any) -> float | None:
    if isinstance(val, (int, float)) and not isinstance(val, bool) and math.isfinite(float(val)):
        return float(val)
    return None


def resolve_remaining_fraction(amount: dict[str, Any], status: Any = None) -> float:
    rem_f = _finite_float(amount.get("remainingFraction"))
    if rem_f is not None:
        return max(0.0, min(1.0, rem_f))

    used_f = _finite_float(amount.get("usedFraction"))
    if used_f is not None:
        return max(0.0, min(1.0, 1.0 - used_f))

    rem = _finite_float(amount.get("remaining"))
    used = _finite_float(amount.get("used"))
    lim = _finite_float(amount.get("limit"))
    unit = str(amount.get("unit") or "")

    if rem is not None and lim is not None and lim > 0:
        return max(0.0, min(1.0, rem / lim))
    if used is not None and lim is not None and lim > 0:
        return max(0.0, min(1.0, 1.0 - (used / lim)))
    if unit == "percent":
        if rem is not None:
            return max(0.0, min(1.0, rem / 100.0))
        if used is not None:
            return max(0.0, min(1.0, 1.0 - (used / 100.0)))

    if str(status or "") == "exhausted":
        return 0.0
    return 0.0


def _short_window_tag(window_id: str, window_label: str) -> str:
    wid = window_id.strip().lower()
    wlbl = window_label.strip().lower()
    if wid in ("5h", "24h", "7d", "1d", "30d"):
        return wid
    if wid == "1mo" or "month" in wlbl or wid == "monthly":
        return "Monthly"
    if wid == "weekly" or "week" in wlbl:
        return "Weekly"
    if "5 hour" in wlbl:
        return "5h"
    if "24 hour" in wlbl:
        return "24h"
    if "7 day" in wlbl:
        return "7d"
    return window_label.strip() or window_id.strip()


def _format_window_display_label(
    raw_label: str,
    window_id: str,
    window_label: str,
    amount: dict[str, Any],
    notes: list[Any],
) -> tuple[str, str]:
    lbl = raw_label.strip() or "Quota"
    lbl = lbl.replace(" (shared)", "")
    lbl = re.sub(r"^Zhipu\s+", "", lbl, flags=re.IGNORECASE)
    wtag = _short_window_tag(window_id, window_label)

    low = lbl.lower()
    if low in ("7 days", "5 hours", "monthly", "weekly"):
        title = f"Primary · {wtag}"
    elif wtag and wtag.lower() not in low and not (
        (wtag == "5h" and "5 hour" in low)
        or (wtag == "7d" and ("7 day" in low or "weekly" in low))
        or (wtag == "24h" and "24 hour" in low)
        or (wtag == "Monthly" and "month" in low)
        or (wtag == "Weekly" and "week" in low)
    ):
        title = f"{lbl} · {wtag}"
    else:
        # Clean verbose English durations inside label
        cleaned = re.sub(r"\b5 Hours?\b", "5h", lbl, flags=re.IGNORECASE)
        cleaned = re.sub(r"\b24 Hours?\b", "24h", cleaned, flags=re.IGNORECASE)
        cleaned = re.sub(r"\b7 Days?\b", "7d", cleaned, flags=re.IGNORECASE)
        title = cleaned

    unit = str(amount.get("unit") or "")
    used = _finite_float(amount.get("used"))
    rem = _finite_float(amount.get("remaining"))
    lim = _finite_float(amount.get("limit"))

    detail = ""
    if unit == "usd" and lim is not None:
        rem_usd = rem if rem is not None else max(0.0, lim - (used or 0.0))
        detail = f"${rem_usd:.0f}/${lim:.0f}"
    elif unit == "requests" and lim is not None:
        rem_req = rem if rem is not None else max(0.0, lim - (used or 0.0))
        detail = f"{int(round(rem_req))}/{int(round(lim))}"
    elif notes:
        first_note = str(notes[0]).strip()
        m_req = re.search(r"(\d+)\s*/\s*(\d+)", first_note)
        if m_req:
            used_n = int(m_req.group(1))
            total_n = int(m_req.group(2))
            detail = f"{max(0, total_n - used_n)}/{total_n}"

    if detail:
        title = f"{title} ({detail})"
    return title, detail


def _provider_meta(provider: str) -> tuple[str, str, int]:
    entry = PROVIDER_CATALOG.get(provider)
    if entry:
        return str(entry["short"]), str(entry["name"]), int(entry["order"])
    parts = [p for p in re.split(r"[-_]+", provider) if p]
    if len(parts) >= 2:
        short = (parts[0][:2] + parts[1][:1]).upper()
    elif parts:
        short = parts[0][:3].upper()
    else:
        short = "UNK"
    return short, provider, 50


def _extract_reset_credits(report: dict[str, Any], now_ms: int) -> int:
    rc = report.get("resetCredits")
    if not isinstance(rc, dict):
        return 0
    avail = rc.get("availableCount")
    if isinstance(avail, (int, float)) and not isinstance(avail, bool):
        return max(0, int(avail))
    credits = rc.get("credits")
    if isinstance(credits, list):
        count = 0
        for item in credits:
            if isinstance(item, dict) and str(item.get("status") or "available") == "available":
                count += 1
        return count
    return 0


def parse_usage_snapshot(raw: dict[str, Any] | None, now_ms: int | None = None) -> UsageSnapshot:
    if now_ms is None:
        now_ms = int(time.time() * 1000)
    if not isinstance(raw, dict):
        return UsageSnapshot()

    gen_raw = _finite_float(raw.get("generatedAt"))
    generated_at_ms = int(gen_raw) if gen_raw else 0
    reports = raw.get("reports")
    if not isinstance(reports, list):
        return UsageSnapshot(generated_at_ms=generated_at_ms)

    cards: list[PoolCardData] = []
    seen_providers: list[str] = []

    for rep in reports:
        if not isinstance(rep, dict):
            continue
        provider = str(rep.get("provider") or "unknown")
        if provider not in seen_providers:
            seen_providers.append(provider)
        short_tag, provider_name, provider_order = _provider_meta(provider)

        meta = rep.get("metadata")
        meta = meta if isinstance(meta, dict) else {}
        plan_type = str(meta.get("planType") or meta.get("orgName") or "").strip()
        email = str(meta.get("email") or "").strip()
        source = str(meta.get("source") or "").strip()
        subtitle_parts: list[str] = []
        if plan_type:
            subtitle_parts.append(plan_type)
        if email:
            subtitle_parts.append(email)
        elif not subtitle_parts and source:
            subtitle_parts.append(source)
        account_subtitle = " · ".join(subtitle_parts)

        reset_credits = _extract_reset_credits(rep, now_ms)

        raw_limits = rep.get("limits")
        raw_limits = raw_limits if isinstance(raw_limits, list) else []

        dedup_seen: dict[str, bool] = {}
        parsed_rows: list[tuple[dict[str, Any], dict[str, Any], dict[str, Any], float]] = []

        for lim in raw_limits:
            if not isinstance(lim, dict):
                continue
            scope = lim.get("scope") if isinstance(lim.get("scope"), dict) else {}
            window = lim.get("window") if isinstance(lim.get("window"), dict) else {}
            amount = lim.get("amount") if isinstance(lim.get("amount"), dict) else {}

            shared_group = str(scope.get("sharedGroup") or "").strip()
            raw_lbl = str(lim.get("label") or "").strip()
            if shared_group:
                dedup_key = f"{shared_group}::{raw_lbl}"
                if dedup_key in dedup_seen:
                    continue
                dedup_seen[dedup_key] = True

            rem_frac = resolve_remaining_fraction(amount, lim.get("status"))
            parsed_rows.append((lim, scope, window, rem_frac))

        # Check whether report has at least one core coding window (non-zread, non-video, non-overage)
        def _is_aux_candidate(lim_d: dict[str, Any], scope_d: dict[str, Any], amt_d: dict[str, Any]) -> bool:
            tier = str(scope_d.get("tier") or "").lower()
            model_id = str(scope_d.get("modelId") or "").lower()
            lbl_low = str(lim_d.get("label") or "").lower()
            unit_low = str(amt_d.get("unit") or "").lower()
            if tier in ("zread", "search", "web") or model_id in ("video", "audio", "image"):
                return True
            if "other models" in lbl_low or "zread" in lbl_low:
                return True
            if unit_low == "requests" and scope_d.get("shared") is False:
                return True
            return False

        has_core = any(
            not _is_aux_candidate(lim_d, scope_d, lim_d.get("amount") or {})
            for lim_d, scope_d, _, _ in parsed_rows
        )

        windows: list[WindowRowData] = []
        for lim_d, scope_d, win_d, rem_frac in parsed_rows:
            amt_d = lim_d.get("amount") if isinstance(lim_d.get("amount"), dict) else {}
            notes = lim_d.get("notes") if isinstance(lim_d.get("notes"), list) else []
            win_id = str(win_d.get("id") or scope_d.get("windowId") or "")
            win_lbl = str(win_d.get("label") or win_id)
            dur_f = _finite_float(win_d.get("durationMs"))
            if dur_f is not None and dur_f > 0:
                duration_ms = int(dur_f)
            else:
                # Infer approximate sorting duration from window id
                wid_low = win_id.lower()
                if "5h" in wid_low:
                    duration_ms = 5 * 3600 * 1000
                elif "24h" in wid_low or "1d" in wid_low:
                    duration_ms = 24 * 3600 * 1000
                elif "7d" in wid_low or "week" in wid_low:
                    duration_ms = 7 * 86400 * 1000
                else:
                    duration_ms = 30 * 86400 * 1000

            resets_f = _finite_float(win_d.get("resetsAt"))
            resets_at_ms = int(resets_f) if resets_f and resets_f > 0 else None

            display_label, detail_suffix = _format_window_display_label(
                str(lim_d.get("label") or ""),
                win_id,
                win_lbl,
                amt_d,
                notes,
            )
            is_aux = has_core and _is_aux_candidate(lim_d, scope_d, amt_d)
            windows.append(
                WindowRowData(
                    limit_id=str(lim_d.get("id") or display_label),
                    display_label=display_label,
                    window_id=win_id,
                    duration_ms=duration_ms,
                    resets_at_ms=resets_at_ms,
                    remaining_frac=rem_frac,
                    remaining_pct=rem_frac * 100.0,
                    is_auxiliary=is_aux,
                    detail_suffix=detail_suffix,
                )
            )

        # Sort windows: core before aux, active (>0%) before exhausted, shorter duration first
        windows.sort(
            key=lambda w: (
                1 if w.is_auxiliary else 0,
                0 if w.remaining_pct > 0.05 else 1,
                w.duration_ms,
                w.display_label,
            )
        )

        if windows:
            primary = windows[0]
            primary_pct = primary.remaining_pct
            primary_resets = primary.resets_at_ms
        else:
            primary_pct = 0.0
            primary_resets = None

        cards.append(
            PoolCardData(
                provider=provider,
                short_tag=short_tag,
                provider_name=provider_name,
                provider_order=provider_order,
                account_subtitle=account_subtitle,
                primary_pct=primary_pct,
                primary_resets_at_ms=primary_resets,
                reset_credits=reset_credits,
                windows=windows,
            )
        )

    # Build provider-level pills for Mini Capsule Strip
    by_provider: dict[str, list[PoolCardData]] = {}
    for c in cards:
        by_provider.setdefault(c.provider, []).append(c)

    pills: list[ProviderPillData] = []
    for prov, group in by_provider.items():
        # Pick healthiest account card for headline %, sum available resetCredits across accounts
        best = max(
            group,
            key=lambda c: (
                c.primary_pct,
                -(c.primary_resets_at_ms or (1 << 60)),
            ),
        )
        total_credits = sum(c.reset_credits for c in group)
        sorted_acct_pcts = tuple(
            int(round(c.primary_pct))
            for c in sorted(group, key=lambda item: (-item.primary_pct, -item.reset_credits))
        )
        pills.append(
            ProviderPillData(
                provider=prov,
                short_tag=best.short_tag,
                provider_order=best.provider_order,
                remaining_pct=best.primary_pct,
                resets_at_ms=best.primary_resets_at_ms,
                reset_credits=total_credits,
                account_remaining_pcts=sorted_acct_pcts,
            )
        )
    pills.sort(key=lambda p: (p.provider_order, p.short_tag))

    # Order full cards: active pools first in canonical provider order, exhausted pools grouped cleanly below
    cards.sort(
        key=lambda c: (
            0 if c.primary_pct > 0.05 else 1,
            c.provider_order,
            -c.primary_pct,
            -c.reset_credits,
            c.account_subtitle,
        )
    )

    ordered_providers = [p.provider for p in pills]
    return UsageSnapshot(
        generated_at_ms=generated_at_ms,
        cards=cards,
        pills=pills,
        providers=ordered_providers,
    )


# ─── Surgical Comment-Preserving `config.yml` Preset Engine ───────────────────


@dataclass
class ModelPresetDef:
    name: str
    default_thinking: str | None = None
    model_roles: dict[str, str] = field(default_factory=dict)

    def summary_subtitle(self) -> str:
        default_sel = self.model_roles.get("default") or next(iter(self.model_roles.values()), "")
        short_model = default_sel.split("/")[-1] if "/" in default_sel else default_sel
        if len(short_model) > 21:
            short_model = short_model[:20] + "…"
        if self.default_thinking:
            return f"{short_model} · {self.default_thinking}" if short_model else self.default_thinking
        return short_model or "custom"


@dataclass
class ConfigPresetState:
    default_thinking: str | None = None
    model_roles: dict[str, str] = field(default_factory=dict)
    presets: dict[str, ModelPresetDef] = field(default_factory=dict)
    active_preset: str | None = None


def _strip_yaml_scalar(raw_val: str) -> str:
    s = raw_val.strip()
    if not s:
        return ""
    if (s.startswith('"') and '"' in s[1:]) or (s.startswith("'") and "'" in s[1:]):
        q = s[0]
        end_idx = s.find(q, 1)
        if end_idx > 0:
            return s[1:end_idx]
    # Strip trailing inline comment preceded by whitespace
    m = re.match(r"^(.*?)\s+#.*$", s)
    if m:
        s = m.group(1).strip()
    if len(s) >= 2 and ((s[0] == '"' and s[-1] == '"') or (s[0] == "'" and s[-1] == "'")):
        s = s[1:-1]
    return s


def parse_config_presets_text(text: str) -> ConfigPresetState:
    lines = text.splitlines()
    default_thinking: str | None = None
    model_roles: dict[str, str] = {}
    presets: dict[str, ModelPresetDef] = {}

    i = 0
    n = len(lines)
    while i < n:
        line = lines[i]
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            i += 1
            continue

        # Top-level defaultThinkingLevel
        m_think = re.match(r"^defaultThinkingLevel\s*:\s*(.+)$", line)
        if m_think:
            val = _strip_yaml_scalar(m_think.group(1))
            if val:
                default_thinking = val
            i += 1
            continue

        # Top-level modelRoles:
        if re.match(r"^modelRoles\s*:\s*(?:#.*)?$", line):
            i += 1
            while i < n:
                sub = lines[i]
                sub_s = sub.strip()
                if not sub_s or sub_s.startswith("#"):
                    if sub and not sub[0].isspace() and sub_s.startswith("#"):
                        # Column-0 section comment ends block
                        break
                    i += 1
                    continue
                if not sub[0].isspace():
                    break
                m_kv = re.match(r"^\s+([A-Za-z0-9_.-]+)\s*:\s*(.+)$", sub)
                if m_kv:
                    r_val = _strip_yaml_scalar(m_kv.group(2))
                    if r_val:
                        model_roles[m_kv.group(1)] = r_val
                i += 1
            continue

        # Top-level modelPresets:
        if re.match(r"^modelPresets\s*:\s*(?:#.*)?$", line):
            i += 1
            preset_indent: int | None = None
            current_preset: ModelPresetDef | None = None
            in_sub_roles = False
            sub_roles_indent = 0

            while i < n:
                sub = lines[i]
                sub_s = sub.strip()
                if not sub_s:
                    i += 1
                    continue
                if not sub[0].isspace():
                    break
                if sub_s.startswith("#"):
                    i += 1
                    continue

                indent = len(sub) - len(sub.lstrip(" "))
                if preset_indent is None or indent <= preset_indent:
                    preset_indent = indent
                    in_sub_roles = False
                    m_p = re.match(r"^\s+([A-Za-z][\w-]*)\s*:\s*(?:#.*)?$", sub)
                    if m_p:
                        pname = m_p.group(1)
                        current_preset = ModelPresetDef(name=pname)
                        presets[pname] = current_preset
                    else:
                        current_preset = None
                    i += 1
                    continue

                if current_preset is not None:
                    if in_sub_roles and indent > sub_roles_indent:
                        m_r = re.match(r"^\s+([A-Za-z0-9_.-]+)\s*:\s*(.+)$", sub)
                        if m_r:
                            rv = _strip_yaml_scalar(m_r.group(2))
                            if rv:
                                current_preset.model_roles[m_r.group(1)] = rv
                        i += 1
                        continue

                    in_sub_roles = False
                    m_pt = re.match(r"^\s+defaultThinkingLevel\s*:\s*(.+)$", sub)
                    if m_pt:
                        tv = _strip_yaml_scalar(m_pt.group(1))
                        if tv:
                            current_preset.default_thinking = tv
                        i += 1
                        continue

                    if re.match(r"^\s+modelRoles\s*:\s*(?:#.*)?$", sub):
                        in_sub_roles = True
                        sub_roles_indent = indent
                        i += 1
                        continue

                i += 1
            continue

        i += 1

    # Resolve active preset:
    # 1. Exact match on all roles + defaultThinkingLevel (identical to omp's findActiveModelPreset)
    # 2. Subset match on all preset-defined roles + defaultThinkingLevel (handles extra auxiliary roles)
    active: str | None = None
    for name, p in presets.items():
        if p.default_thinking is not None and p.default_thinking != default_thinking:
            continue
        if p.model_roles and p.model_roles == model_roles:
            active = name
            break

    if active is None:
        for name, p in presets.items():
            if not p.model_roles:
                continue
            if p.default_thinking is not None and p.default_thinking != default_thinking:
                continue
            if all(model_roles.get(k) == v for k, v in p.model_roles.items()):
                active = name
                break

    return ConfigPresetState(
        default_thinking=default_thinking,
        model_roles=model_roles,
        presets=presets,
        active_preset=active,
    )


def apply_preset_to_config_text(text: str, preset_name: str) -> str:
    """
    Surgically update top-level `defaultThinkingLevel:` and `modelRoles:` in `config.yml`
    while keeping 100% of comments, blank lines, quotes, and surrounding sections intact.
    """
    state = parse_config_presets_text(text)
    preset = state.presets.get(preset_name)
    if preset is None:
        raise KeyError(f"Preset '{preset_name}' not found in config.yml")
    if not preset.model_roles:
        raise ValueError(f"Preset '{preset_name}' defines no modelRoles")

    nl = "\r\n" if "\r\n" in text else "\n"
    had_trailing_nl = text.endswith("\n")
    lines = text.splitlines()

    # 1. Surgical update of top-level defaultThinkingLevel
    if preset.default_thinking:
        updated_thinking = False
        for idx, line in enumerate(lines):
            m = re.match(r"^(defaultThinkingLevel\s*:\s*)([^\s#]+)(.*)$", line)
            if m:
                lines[idx] = f"{m.group(1)}{preset.default_thinking}{m.group(3)}"
                updated_thinking = True
                break
        if not updated_thinking:
            insert_at = 0
            for idx, line in enumerate(lines):
                if re.match(r"^modelRoles\s*:", line):
                    insert_at = idx
                    break
            lines.insert(insert_at, f"defaultThinkingLevel: {preset.default_thinking}")

    # 2. Surgical update of top-level modelRoles block
    mr_idx: int | None = None
    for idx, line in enumerate(lines):
        if re.match(r"^modelRoles\s*:\s*(?:#.*)?$", line):
            mr_idx = idx
            break

    if mr_idx is not None:
        role_indent = "  "
        last_indented_idx = mr_idx
        j = mr_idx + 1
        while j < len(lines):
            sub = lines[j]
            sub_s = sub.strip()
            if not sub_s:
                j += 1
                continue
            if not sub[0].isspace():
                break
            if role_indent == "  ":
                leading = sub[: len(sub) - len(sub.lstrip(" \t"))]
                if leading:
                    role_indent = leading
            last_indented_idx = j
            j += 1

        # Preserve any auxiliary roles not managed by ANY preset (e.g. advisor, memory)
        # ONLY if we check whether presets omit them? Wait: omp's `/modelpreset switch` replaces
        # modelRoles with preset.model_roles so `findActiveModelPreset` matches cleanly, OR if we
        # preserve auxiliary roles not touched by any preset? Wait: in omp's `findActiveModelPreset`:
        # `presetIds.length === roleIds.length && presetIds.every(...)`!
        # Wait: let's check! If user has `advisor` and `memory` in `modelRoles`, and clicks a preset
        # in HUD, replacing `modelRoles` with `preset.model_roles` makes BOTH omp's TUI `/quota`
        # `findActiveModelPreset` AND HUD match 100%!
        new_role_lines = [f"{role_indent}{role}: {sel}" for role, sel in preset.model_roles.items()]
        lines[mr_idx + 1 : last_indented_idx + 1] = new_role_lines
    else:
        if lines and lines[-1].strip() != "":
            lines.append("")
        lines.append("modelRoles:")
        for role, sel in preset.model_roles.items():
            lines.append(f"  {role}: {sel}")

    out = nl.join(lines)
    if had_trailing_nl:
        out += nl
    return out


# ─── Formatting & Semantic Colors ─────────────────────────────────────────────


def quota_palette(pct: float) -> tuple[str, str, str, str]:
    """Return `(bar_color, text_color, pill_bg, pill_border)` for remaining percentage."""
    if pct <= 0.05:
        return (THEME["rose"], THEME["rose_text"], THEME["rose_bg"], THEME["rose_border"])
    if pct < 25.0:
        return (THEME["orange"], THEME["orange_text"], THEME["orange_bg"], THEME["orange_border"])
    if pct < 60.0:
        return (THEME["amber"], THEME["amber_text"], THEME["amber_bg"], THEME["amber_border"])
    return (THEME["emerald"], THEME["emerald_text"], THEME["emerald_bg"], THEME["emerald_border"])


def format_countdown_full(resets_at_ms: int | None, now_ms: int) -> str:
    if not resets_at_ms or resets_at_ms <= 0:
        return ""
    diff_sec = int((resets_at_ms - now_ms) // 1000)
    if diff_sec <= 0:
        return "重置 已到点"
    days, rem = divmod(diff_sec, 86400)
    hours, rem = divmod(rem, 3600)
    mins, secs = divmod(rem, 60)
    if days > 0:
        return f"重置 {days}d {hours:02d}h {mins:02d}m {secs:02d}s"
    if hours > 0:
        return f"重置 {hours}h {mins:02d}m {secs:02d}s"
    return f"重置 {mins}m {secs:02d}s"


def format_freshness(generated_at_ms: int, now_ms: int, refreshing: bool) -> str:
    if refreshing:
        return "⟳ 正在刷新配额…"
    if generated_at_ms <= 0:
        return "未加载缓存"
    age_sec = max(0, int((now_ms - generated_at_ms) // 1000))
    if age_sec < 6:
        return "刚刚更新"
    if age_sec < 60:
        return f"{age_sec}s前"
    if age_sec < 3600:
        return f"{age_sec // 60}m {age_sec % 60:02d}s前"
    return f"{age_sec // 3600}h {(age_sec % 3600) // 60}m前"


def find_omp_executable() -> str | None:
    preferred = HOME_DIR / ".bun" / "bin" / "omp.exe"
    if preferred.exists():
        return str(preferred)
    for cand in ("omp.exe", "omp"):
        found = shutil.which(cand)
        if found:
            return found
    return None


# ─── Localhost Single-Instance IPC Client ─────────────────────────────────────


def send_control_command(cmd: str, timeout: float = 1.2) -> dict[str, Any] | None:
    state = read_json_file(SOCKET_STATE_PATH)
    if not state:
        return None
    port = state.get("port")
    token = state.get("token")
    if not isinstance(port, int) or port <= 0 or port > 65535:
        return None
    payload = json.dumps({"cmd": cmd, "token": token or ""}) + "\n"
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=timeout) as sock:
            sock.settimeout(timeout)
            sock.sendall(payload.encode("utf-8"))
            chunks: list[bytes] = []
            while True:
                data = sock.recv(4096)
                if not data:
                    break
                chunks.append(data)
                if b"\n" in data:
                    break
        raw = b"".join(chunks).decode("utf-8", errors="replace").strip()
        if not raw:
            return None
        parsed = json.loads(raw.splitlines()[0])
        return parsed if isinstance(parsed, dict) else None
    except OSError:
        return None
    except Exception:
        return None


def spawn_detached_hud_daemon(initial_mode: str | None) -> bool:
    script_path = Path(__file__).resolve()
    py_dir = Path(sys.executable).resolve().parent
    pythonw = py_dir / "pythonw.exe"
    if not pythonw.exists():
        alt = Path(r"C:\Python312\pythonw.exe")
        pythonw = alt if alt.exists() else Path(sys.executable).resolve()

    cmd = [str(pythonw), str(script_path), "--daemon"]
    if initial_mode in ("mini", "full"):
        cmd.extend(["--initial-mode", initial_mode])

    creationflags = 0
    if sys.platform == "win32":
        DETACHED_PROCESS = 0x00000008
        CREATE_NEW_PROCESS_GROUP = 0x00000200
        CREATE_NO_WINDOW = 0x08000000
        creationflags = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW

    try:
        subprocess.Popen(
            cmd,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=True,
            creationflags=creationflags,
        )
    except Exception as exc:
        log_debug(f"Failed to spawn daemon: {exc}")
        return False

    # Wait briefly for control socket to come online (< 2.5s)
    deadline = time.monotonic() + 2.5
    while time.monotonic() < deadline:
        resp = send_control_command("status", timeout=0.25)
        if resp and resp.get("running") is True:
            return True
        time.sleep(0.03)
    return False


# ─── Tkinter Desktop Floating HUD Daemon ──────────────────────────────────────


class OmpQuotaHudApp:
    def __init__(self, initial_mode: str | None = None) -> None:
        global tk
        import tkinter as _tk

        tk = _tk
        self.dpi_mode = enable_per_monitor_dpi()
        self.ui_state = self._load_ui_state()

        if initial_mode in ("mini", "full"):
            self.mode: str = initial_mode
        else:
            saved_mode = str(self.ui_state.get("mode") or "full")
            self.mode = saved_mode if saved_mode in ("mini", "full") else "full"

        self.topmost: bool = bool(self.ui_state.get("topmost", True))
        self.show_left: bool = bool(self.ui_state.get("show_left", True))
        self.visible: bool = True
        self.refreshing: bool = False
        self.closing: bool = False
        self.last_refresh_attempt_ms: int = 0
        self.toast_text: str = ""
        self.toast_until_ms: int = 0

        self.usage_mtime_sig: tuple[int, int] = (0, 0)
        self.config_mtime_sig: tuple[int, int] = (0, 0)

        self.snapshot: UsageSnapshot = UsageSnapshot()
        self.config_state: ConfigPresetState = ConfigPresetState()

        # Thread-safe IPC & worker queues
        self.cmd_queue: queue.Queue[tuple[str, threading.Event, dict[str, Any]]] = queue.Queue()
        self.bg_queue: queue.Queue[tuple[str, Any]] = queue.Queue()
        self._status_lock = threading.Lock()
        self._status_cache: dict[str, Any] = {}

        # Live 1-second countdown bindings (in-place .configure(text=...), zero flicker)
        self._freshness_label: tk.Label | None = None
        self._toast_label: tk.Label | None = None
        self._refresh_btn_label: tk.Label | None = None
        self._countdown_targets: list[tuple[tk.Label, int]] = []
        self._mini_pill_targets: list[tuple[tk.Label, ProviderPillData]] = []

        # Scroll canvas references for --full mode
        self._cards_canvas: tk.Canvas | None = None
        self._cards_window_id: int | None = None
        self._scroll_thumb_canvas: tk.Canvas | None = None

        # Drag state
        self._drag_origin_root: tuple[int, int] | None = None
        self._drag_origin_win: tuple[int, int] | None = None

        # Start localhost TCP control socket first
        self.token = secrets.token_hex(16)
        self.server_sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.server_sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.server_sock.bind(("127.0.0.1", 0))
        self.server_sock.listen(8)
        self.port = int(self.server_sock.getsockname()[1])

        # Load data before first paint
        self._reload_usage_from_disk(force=True)
        self._reload_config_from_disk(force=True)
        self._sync_status_snapshot()
        self._write_socket_state()

        self._accept_thread = threading.Thread(target=self._socket_accept_loop, name="hud-ipc", daemon=True)
        self._accept_thread.start()

        # Initialize Tk root
        self.root = tk.Tk()
        self.root.withdraw()
        self.root.title("OMP Coding Plans HUD")
        self.root.configure(bg=THEME["border"])
        self.root.overrideredirect(True)
        self.root.attributes("-topmost", self.topmost)

        # Determine target position & monitor DPI before building widgets
        init_x, init_y = self._saved_pos_for_mode(self.mode)
        dpi, _ = get_monitor_dpi_and_workarea(init_x, init_y)
        self.dpi: int = dpi
        self.scale: float = max(1.0, dpi / 96.0)
        try:
            self.root.tk.call("tk", "scaling", dpi / 72.0)
        except Exception:
            pass

        self.font_family = self._pick_font_family()
        self.outer = tk.Frame(self.root, bg=THEME["bg"], bd=0, highlightthickness=1, highlightbackground=THEME["border"])
        self.outer.pack(fill="both", expand=True)

        self.root.bind_all("<MouseWheel>", self._on_mousewheel, add="+")
        self.root.protocol("WM_DELETE_WINDOW", self.shutdown)

        self._rebuild_ui(reposition=True)
        self.root.deiconify()
        self.root.lift()
        self._apply_hwnd_styles()
        self._sync_status_snapshot()

        # Kick off auto-refresh if cache is missing or older than 5 minutes
        now_ms = int(time.time() * 1000)
        if self.snapshot.generated_at_ms <= 0 or (now_ms - self.snapshot.generated_at_ms) > AUTO_REFRESH_MAX_AGE_MS:
            self.trigger_background_refresh(force=True)

        # Schedule timers
        self.root.after(15, self._drain_queues_loop)
        self.root.after(1000, self._tick_1s_loop)
        self.root.after(2000, self._poll_files_2s_loop)

    # ─── Scaling & Typography ─────────────────────────────────────────────────

    def px(self, value: float) -> int:
        return max(1, int(round(value * self.scale)))

    def font(self, px_size: int, weight: str = "normal") -> tuple[Any, ...]:
        # Negative font size in Tkinter specifies exact pixel height, immune to point rounding drift
        if weight == "bold":
            return (self.font_family, -self.px(px_size), "bold")
        return (self.font_family, -self.px(px_size))

    def _pick_font_family(self) -> str:
        try:
            import tkinter.font as tkfont

            fams = set(tkfont.families(self.root))
            for candidate in ("Segoe UI Variable Text", "Microsoft YaHei UI", "Segoe UI"):
                if candidate in fams:
                    return candidate
        except Exception:
            pass
        return "Segoe UI"

    def _apply_hwnd_styles(self) -> None:
        if sys.platform != "win32":
            return
        try:
            self.root.update_idletasks()
            hwnd = ctypes.windll.user32.GetParent(self.root.winfo_id()) or self.root.winfo_id()
            apply_win11_window_chrome(hwnd)
        except Exception:
            pass

    # ─── Persistence (Socket & UI State) ──────────────────────────────────────

    def _load_ui_state(self) -> dict[str, Any]:
        data = read_json_file(UI_STATE_PATH)
        return data if isinstance(data, dict) else {}

    def _save_ui_state(self) -> None:
        try:
            self.ui_state["mode"] = self.mode
            self.ui_state["topmost"] = self.topmost
            atomic_write_text(UI_STATE_PATH, json.dumps(self.ui_state, indent=2, ensure_ascii=False))
        except Exception as exc:
            log_debug(f"Failed saving UI state: {exc}")

    def _saved_pos_for_mode(self, mode: str) -> tuple[int, int]:
        key = f"{mode}_pos"
        pos = self.ui_state.get(key)
        if isinstance(pos, list) and len(pos) == 2 and all(isinstance(v, (int, float)) for v in pos):
            return int(pos[0]), int(pos[1])
        # Default top-right area of primary monitor
        _, (wl, wt, wr, _) = get_monitor_dpi_and_workarea(100, 100)
        default_w = 680 if mode == "mini" else 468
        return max(wl + 16, wr - default_w - 24), wt + (16 if mode == "mini" else 44)

    def _clamp_geometry_to_workarea(self, x: int, y: int, w: int, h: int) -> tuple[int, int]:
        vx1, vy1, vx2, vy2 = get_virtual_screen_bounds()
        # First ensure reference point is within virtual screen
        cx = max(vx1, min(x, vx2 - 40))
        cy = max(vy1, min(y, vy2 - 40))
        _, (wl, wt, wr, wb) = get_monitor_dpi_and_workarea(cx + min(w // 2, 120), cy + 20)
        pad = self.px(8)
        if w < (wr - wl - pad * 2):
            cx = max(wl + pad, min(cx, wr - w - pad))
        else:
            cx = wl + pad
        if h < (wb - wt - pad * 2):
            cy = max(wt + pad, min(cy, wb - h - pad))
        else:
            cy = wt + pad
        return cx, cy

    def _write_socket_state(self) -> None:
        payload = {
            "pid": os.getpid(),
            "port": self.port,
            "token": self.token,
            "startedAt": int(time.time() * 1000),
            "dpiMode": self.dpi_mode,
        }
        atomic_write_text(SOCKET_STATE_PATH, json.dumps(payload, indent=2))

    def _remove_socket_state(self) -> None:
        try:
            existing = read_json_file(SOCKET_STATE_PATH)
            if existing and existing.get("pid") == os.getpid():
                SOCKET_STATE_PATH.unlink(missing_ok=True)
        except OSError:
            pass

    def _sync_status_snapshot(self) -> None:
        snap = {
            "ok": True,
            "running": not self.closing,
            "pid": os.getpid(),
            "port": self.port,
            "dpiMode": self.dpi_mode,
            "dpi": getattr(self, "dpi", 96),
            "mode": self.mode,
            "visible": self.visible,
            "topmost": self.topmost,
            "refreshing": self.refreshing,
            "activePreset": self.config_state.active_preset,
            "presets": list(self.config_state.presets.keys()),
            "providerCount": len(self.snapshot.providers),
            "poolCount": len(self.snapshot.cards),
            "providers": list(self.snapshot.providers),
            "generatedAt": self.snapshot.generated_at_ms,
        }
        with self._status_lock:
            self._status_cache = snap

    def get_status_snapshot(self) -> dict[str, Any]:
        with self._status_lock:
            return dict(self._status_cache)

    # ─── Localhost TCP Control Socket Thread ──────────────────────────────────

    def _socket_accept_loop(self) -> None:
        while not self.closing:
            try:
                conn, _ = self.server_sock.accept()
            except OSError:
                break
            threading.Thread(target=self._handle_client_conn, args=(conn,), daemon=True).start()

    def _handle_client_conn(self, conn: socket.socket) -> None:
        with conn:
            try:
                conn.settimeout(1.5)
                data = b""
                while b"\n" not in data and len(data) < 8192:
                    chunk = conn.recv(4096)
                    if not chunk:
                        break
                    data += chunk
                line = data.decode("utf-8", errors="replace").strip()
                req = json.loads(line) if line else {}
                if not isinstance(req, dict):
                    return
                if req.get("token") != self.token:
                    resp = {"ok": False, "error": "unauthorized"}
                    conn.sendall((json.dumps(resp) + "\n").encode("utf-8"))
                    return

                cmd = str(req.get("cmd") or "status").lower()
                if cmd == "status":
                    resp = self.get_status_snapshot()
                    conn.sendall((json.dumps(resp) + "\n").encode("utf-8"))
                    return

                ev = threading.Event()
                box: dict[str, Any] = {}
                self.cmd_queue.put((cmd, ev, box))
                ev.wait(timeout=1.5)
                resp = box.get("result") or self.get_status_snapshot()
                conn.sendall((json.dumps(resp) + "\n").encode("utf-8"))
            except Exception:
                pass

    # ─── Data Loading & Background Refresh ────────────────────────────────────

    def _file_sig(self, path: Path) -> tuple[int, int]:
        try:
            st = path.stat()
            return (st.st_mtime_ns, st.st_size)
        except OSError:
            return (0, 0)

    def _reload_usage_from_disk(self, force: bool = False) -> bool:
        sig = self._file_sig(USAGE_CACHE_PATH)
        if not force and sig == self.usage_mtime_sig:
            return False
        self.usage_mtime_sig = sig
        raw = read_json_file(USAGE_CACHE_PATH)
        if raw is not None:
            self.snapshot = parse_usage_snapshot(raw)
            return True
        return False

    def _reload_config_from_disk(self, force: bool = False) -> bool:
        sig = self._file_sig(CONFIG_YML_PATH)
        if not force and sig == self.config_mtime_sig:
            return False
        self.config_mtime_sig = sig
        try:
            if CONFIG_YML_PATH.exists():
                txt = CONFIG_YML_PATH.read_text(encoding="utf-8")
                self.config_state = parse_config_presets_text(txt)
                return True
        except Exception as exc:
            log_debug(f"Failed parsing config.yml: {exc}")
        return False

    def trigger_background_refresh(self, force: bool = False) -> None:
        if self.refreshing:
            return
        now_ms = int(time.time() * 1000)

        # If triggered externally (e.g. TUI `/quota refresh` just wrote finops-live-usage.json <5s ago),
        # pick up the fresh cache immediately without spawning a duplicate `omp usage --json`!
        if not force:
            if self._reload_usage_from_disk(force=False):
                self._rebuild_ui(reposition=False)
                self._sync_status_snapshot()
            if self.snapshot.generated_at_ms > 0 and (now_ms - self.snapshot.generated_at_ms) < 5000:
                self._show_toast("✓ 已同步最新配额")
                return
            if (now_ms - self.last_refresh_attempt_ms) < 4000:
                return

        omp_exe = find_omp_executable()
        if not omp_exe:
            self._show_toast("未找到 omp.exe")
            return

        self.refreshing = True
        self.last_refresh_attempt_ms = now_ms
        self._sync_status_snapshot()
        self._update_refresh_indicators()

        def _worker() -> None:
            creationflags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
            try:
                proc = subprocess.run(
                    [omp_exe, "usage", "--json"],
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    timeout=90,
                    creationflags=creationflags,
                )
                stdout = (proc.stdout or "").strip()
                # Extract JSON object even if warning lines preceded it
                json_start = stdout.find("{")
                json_end = stdout.rfind("}")
                if json_start >= 0 and json_end > json_start:
                    data = json.loads(stdout[json_start : json_end + 1])
                    if isinstance(data, dict) and isinstance(data.get("reports"), list):
                        if "generatedAt" not in data:
                            data["generatedAt"] = int(time.time() * 1000)
                        serialized = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
                        atomic_write_text(USAGE_CACHE_PATH, serialized)
                        self.bg_queue.put(("refresh_ok", data))
                        return
                err_tail = ((proc.stderr or stdout) or f"exit {proc.returncode}").strip().splitlines()
                msg = err_tail[-1][:48] if err_tail else f"exit {proc.returncode}"
                self.bg_queue.put(("refresh_err", msg))
            except subprocess.TimeoutExpired:
                self.bg_queue.put(("refresh_err", "刷新超时 (90s)"))
            except Exception as exc:
                self.bg_queue.put(("refresh_err", str(exc)[:48]))

        threading.Thread(target=_worker, name="hud-omp-usage", daemon=True).start()

    def _update_refresh_indicators(self) -> None:
        now_ms = int(time.time() * 1000)
        if self._freshness_label is not None:
            try:
                self._freshness_label.configure(
                    text=format_freshness(self.snapshot.generated_at_ms, now_ms, self.refreshing),
                    fg=THEME["cyan"] if self.refreshing else THEME["text_secondary"],
                )
            except tk.TclError:
                pass
        if self._refresh_btn_label is not None:
            try:
                if self.mode == "mini":
                    self._refresh_btn_label.configure(
                        text="…" if self.refreshing else "⟳",
                        fg=THEME["cyan"] if self.refreshing else THEME["text_primary"],
                    )
                else:
                    self._refresh_btn_label.configure(
                        text="⟳ 刷新中" if self.refreshing else "⟳ 强刷",
                        fg=THEME["cyan"] if self.refreshing else THEME["text_primary"],
                    )
            except tk.TclError:
                pass

    def _show_toast(self, message: str, duration_ms: int = 3200) -> None:
        self.toast_text = message
        self.toast_until_ms = int(time.time() * 1000) + duration_ms
        if self._toast_label is not None:
            try:
                self._toast_label.configure(text=message, fg=THEME["cyan"])
            except tk.TclError:
                pass

    # ─── Preset Switching Action ──────────────────────────────────────────────

    def switch_model_preset(self, preset_name: str) -> None:
        try:
            if not CONFIG_YML_PATH.exists():
                self._show_toast("config.yml 不存在")
                return
            raw_text = CONFIG_YML_PATH.read_text(encoding="utf-8")
            updated_text = apply_preset_to_config_text(raw_text, preset_name)
            atomic_write_text(CONFIG_YML_PATH, updated_text)
            self._reload_config_from_disk(force=True)
            self.toast_text = f"✓ 已热切: {preset_name}"
            self.toast_until_ms = int(time.time() * 1000) + 3500
            self._rebuild_ui(reposition=False)
            self._sync_status_snapshot()
        except Exception as exc:
            log_debug(f"Preset switch error ({preset_name}): {exc}\n{traceback.format_exc()}")
            self._show_toast(f"切换失败: {exc}")

    # ─── Mode, Visibility & Pin Actions ───────────────────────────────────────

    def set_mode(self, new_mode: str) -> None:
        if new_mode not in ("mini", "full"):
            return
        if new_mode == self.mode:
            self.bring_to_front()
            return
        # Save current position for outgoing mode before switching
        try:
            self.ui_state[f"{self.mode}_pos"] = [int(self.root.winfo_x()), int(self.root.winfo_y())]
        except Exception:
            pass
        self.mode = new_mode
        self._save_ui_state()
        self._rebuild_ui(reposition=True)
        self.bring_to_front()
        self._sync_status_snapshot()

    def toggle_topmost(self) -> None:
        self.topmost = not self.topmost
        self.root.attributes("-topmost", self.topmost)
        self._save_ui_state()
        self._rebuild_ui(reposition=False)
        self._sync_status_snapshot()
    def toggle_polarity(self) -> None:
        self.show_left = not self.show_left
        self.ui_state["show_left"] = self.show_left
        self._save_ui_state()
        self._rebuild_ui(reposition=False)
        self._sync_status_snapshot()

    def bring_to_front(self) -> None:
        if not self.visible:
            self.visible = True
            self.root.deiconify()
            self._apply_hwnd_styles()
        self.root.lift()
        if self.topmost:
            self.root.attributes("-topmost", True)
        self._sync_status_snapshot()

    def toggle_visibility(self) -> None:
        if self.visible:
            try:
                self.ui_state[f"{self.mode}_pos"] = [int(self.root.winfo_x()), int(self.root.winfo_y())]
                self._save_ui_state()
            except Exception:
                pass
            self.visible = False
            self.root.withdraw()
            self._sync_status_snapshot()
        else:
            self.bring_to_front()

    def shutdown(self) -> None:
        if self.closing:
            return
        self.closing = True
        try:
            if self.visible:
                self.ui_state[f"{self.mode}_pos"] = [int(self.root.winfo_x()), int(self.root.winfo_y())]
            self._save_ui_state()
        except Exception:
            pass
        self._sync_status_snapshot()
        self._remove_socket_state()
        try:
            self.server_sock.close()
        except Exception:
            pass
        try:
            self.root.quit()
            self.root.destroy()
        except Exception:
            pass

    # ─── Event Loops (30ms IPC Drain, 1s Countdown Tick, 2s Mtime Poll) ───────

    def _drain_queues_loop(self) -> None:
        if self.closing:
            return
        # 1. Process incoming localhost CLI commands
        while True:
            try:
                cmd, ev, box = self.cmd_queue.get_nowait()
            except queue.Empty:
                break
            deferred_mode: str | None = None
            try:
                if cmd == "open":
                    self.bring_to_front()
                elif cmd == "toggle":
                    self.toggle_visibility()
                elif cmd in ("mini", "full"):
                    if cmd != self.mode:
                        try:
                            self.ui_state[f"{self.mode}_pos"] = [int(self.root.winfo_x()), int(self.root.winfo_y())]
                        except Exception:
                            pass
                        self.mode = cmd
                        self.visible = True
                        deferred_mode = cmd
                    else:
                        self.bring_to_front()
                elif cmd in ("refresh", "force-refresh"):
                    self.trigger_background_refresh(force=(cmd == "force-refresh"))
                elif cmd == "close":
                    self._sync_status_snapshot()
                    box["result"] = {**self.get_status_snapshot(), "running": False, "closing": True}
                    ev.set()
                    self.root.after(15, self.shutdown)
                    return
            finally:
                self._sync_status_snapshot()
                box["result"] = self.get_status_snapshot()
                ev.set()

            if deferred_mode is not None:
                self._save_ui_state()
                self._rebuild_ui(reposition=True)
                self.bring_to_front()
                self._sync_status_snapshot()

        # 2. Process background refresh results
        while True:
            try:
                kind, payload = self.bg_queue.get_nowait()
            except queue.Empty:
                break
            self.refreshing = False
            if kind == "refresh_ok":
                self.usage_mtime_sig = self._file_sig(USAGE_CACHE_PATH)
                self.snapshot = parse_usage_snapshot(payload)
                self.toast_text = "✓ 配额强刷完成"
                self.toast_until_ms = int(time.time() * 1000) + 3000
                self._rebuild_ui(reposition=False)
            elif kind == "refresh_err":
                self._update_refresh_indicators()
                self._show_toast(f"刷新异常: {payload}", duration_ms=4500)
            self._sync_status_snapshot()

        if not self.closing:
            self.root.after(15, self._drain_queues_loop)

    def _tick_1s_loop(self) -> None:
        if self.closing:
            return
        now_ms = int(time.time() * 1000)

        # Update freshness label in-place
        if self._freshness_label is not None:
            try:
                new_fresh = format_freshness(self.snapshot.generated_at_ms, now_ms, self.refreshing)
                if self._freshness_label.cget("text") != new_fresh:
                    self._freshness_label.configure(text=new_fresh)
            except tk.TclError:
                pass

        # Clear expired toast back to active preset indicator
        if self._toast_label is not None and self.toast_text and now_ms > self.toast_until_ms:
            self.toast_text = ""
            try:
                fallback = (
                    f"当前: {self.config_state.active_preset}"
                    if self.config_state.active_preset
                    else "当前: 自定义角色矩阵"
                )
                self._toast_label.configure(text=fallback, fg=THEME["text_secondary"])
            except tk.TclError:
                pass

        # Update every live window reset countdown label in-place (zero widget churn / zero flicker)
        for lbl, resets_at_ms in self._countdown_targets:
            try:
                new_txt = format_countdown_full(resets_at_ms, now_ms)
                if lbl.cget("text") != new_txt:
                    lbl.configure(text=new_txt)
            except tk.TclError:
                pass

        # Update mini capsule texts if hour/minute bucket ticked over
        for lbl, pill in self._mini_pill_targets:
            try:
                new_txt = pill.format_text(now_ms)
                if lbl.cget("text") != new_txt:
                    lbl.configure(text=new_txt)
            except tk.TclError:
                pass

        if not self.closing:
            self.root.after(1000, self._tick_1s_loop)

    def _poll_files_2s_loop(self) -> None:
        if self.closing:
            return
        usage_changed = self._reload_usage_from_disk(force=False)
        config_changed = self._reload_config_from_disk(force=False)
        if usage_changed or config_changed:
            self._rebuild_ui(reposition=False)
            self._sync_status_snapshot()

        # Auto-refresh if cache ages past 5 minutes
        now_ms = int(time.time() * 1000)
        if (
            not self.refreshing
            and (self.snapshot.generated_at_ms <= 0 or (now_ms - self.snapshot.generated_at_ms) > AUTO_REFRESH_MAX_AGE_MS)
            and (now_ms - self.last_refresh_attempt_ms) > AUTO_REFRESH_RETRY_COOLDOWN_MS
        ):
            self.trigger_background_refresh(force=True)

        if not self.closing:
            self.root.after(2000, self._poll_files_2s_loop)

    # ─── Dragging & Per-Monitor DPI Adaptation ────────────────────────────────

    def _bind_draggable(self, widget: tk.Widget) -> None:
        widget.bind("<ButtonPress-1>", self._on_drag_start, add="+")
        widget.bind("<B1-Motion>", self._on_drag_motion, add="+")
        widget.bind("<ButtonRelease-1>", self._on_drag_end, add="+")

    def _on_drag_start(self, event: tk.Event[Any]) -> None:
        self._drag_origin_root = (int(event.x_root), int(event.y_root))
        self._drag_origin_win = (int(self.root.winfo_x()), int(self.root.winfo_y()))

    def _on_drag_motion(self, event: tk.Event[Any]) -> None:
        if self._drag_origin_root is None or self._drag_origin_win is None:
            return
        dx = int(event.x_root) - self._drag_origin_root[0]
        dy = int(event.y_root) - self._drag_origin_root[1]
        nx = self._drag_origin_win[0] + dx
        ny = self._drag_origin_win[1] + dy
        self.root.geometry(f"+{nx}+{ny}")

    def _on_drag_end(self, _event: tk.Event[Any]) -> None:
        if self._drag_origin_root is None:
            return
        self._drag_origin_root = None
        self._drag_origin_win = None
        try:
            wx = int(self.root.winfo_x())
            wy = int(self.root.winfo_y())
            self.ui_state[f"{self.mode}_pos"] = [wx, wy]
            self._save_ui_state()
            # Check if dragged onto a monitor with different DPI (e.g. 2K 96-DPI <-> 4K 120/192-DPI)
            new_dpi, _ = get_monitor_dpi_and_workarea(wx + 60, wy + 20)
            if abs(new_dpi - self.dpi) >= 12:
                self.dpi = new_dpi
                self.scale = max(1.0, new_dpi / 96.0)
                try:
                    self.root.tk.call("tk", "scaling", new_dpi / 72.0)
                except Exception:
                    pass
                self._rebuild_ui(reposition=True)
        except Exception:
            pass

    # ─── UI Construction (Mini Capsule Strip & Full Multi-Pool Dashboard) ─────

    def _make_action_btn(
        self,
        parent: tk.Widget,
        text: str,
        command: Any,
        *,
        fg: str = THEME["text_primary"],
        bg: str = THEME["btn_bg"],
        hover_bg: str = THEME["btn_hover"],
        border_color: str = THEME["divider"],
        padx: int = 8,
        pady: int = 3,
        font_px: int = 11,
        bold: bool = False,
    ) -> tuple[tk.Frame, tk.Label]:
        wrap = tk.Frame(parent, bg=bg, bd=0, highlightthickness=1, highlightbackground=border_color, cursor="hand2")
        lbl = tk.Label(
            wrap,
            text=text,
            fg=fg,
            bg=bg,
            font=self.font(font_px, "bold" if bold else "normal"),
            padx=self.px(padx),
            pady=self.px(pady),
            cursor="hand2",
        )
        lbl.pack()

        def _enter(_e: Any) -> None:
            wrap.configure(bg=hover_bg)
            lbl.configure(bg=hover_bg)

        def _leave(_e: Any) -> None:
            wrap.configure(bg=bg)
            lbl.configure(bg=bg)

        def _click(_e: Any) -> None:
            command()

        for w in (wrap, lbl):
            w.bind("<Enter>", _enter)
            w.bind("<Leave>", _leave)
            w.bind("<ButtonRelease-1>", _click)
        return wrap, lbl

    def _rebuild_ui(self, reposition: bool = False) -> None:
        self._freshness_label = None
        self._toast_label = None
        self._refresh_btn_label = None
        self._countdown_targets.clear()
        self._mini_pill_targets.clear()
        self._cards_canvas = None
        self._cards_window_id = None
        self._scroll_thumb_canvas = None

        for child in self.outer.winfo_children():
            child.destroy()

        if reposition:
            tx, ty = self._saved_pos_for_mode(self.mode)
            mon_dpi, work = get_monitor_dpi_and_workarea(tx, ty)
            if abs(mon_dpi - self.dpi) >= 12:
                self.dpi = mon_dpi
                self.scale = max(1.0, mon_dpi / 96.0)
                try:
                    self.root.tk.call("tk", "scaling", mon_dpi / 72.0)
                except Exception:
                    pass
        else:
            tx, ty = int(self.root.winfo_x()), int(self.root.winfo_y())
            _, work = get_monitor_dpi_and_workarea(tx, ty)

        now_ms = int(time.time() * 1000)

        if self.mode == "mini":
            self._build_mini_strip(now_ms)
            self.root.update_idletasks()
            req_w = max(self.px(540), self.outer.winfo_reqwidth())
            req_h = max(self.px(44), self.outer.winfo_reqheight())
            if reposition:
                tx, ty = self._clamp_geometry_to_workarea(tx, ty, req_w, req_h)
                self.ui_state["mini_pos"] = [tx, ty]
            self.root.geometry(f"{req_w}x{req_h}+{tx}+{ty}")
        else:
            work_h = max(480, work[3] - work[1])
            target_w = self.px(472)
            target_h = min(self.px(640), work_h - self.px(36))
            self._build_full_dashboard(now_ms)
            self.root.update_idletasks()
            if reposition:
                tx, ty = self._clamp_geometry_to_workarea(tx, ty, target_w, target_h)
                self.ui_state["full_pos"] = [tx, ty]
            self.root.geometry(f"{target_w}x{target_h}+{tx}+{ty}")

    # ─── ① Mini Capsule Strip Mode (`--mini`) ─────────────────────────────────

    def _build_mini_strip(self, now_ms: int) -> None:
        bar = tk.Frame(self.outer, bg=THEME["header_bg"], padx=self.px(8), pady=self.px(6))
        bar.pack(fill="both", expand=True)
        self._bind_draggable(bar)

        # Drag handle grip
        grip = tk.Label(
            bar,
            text="⠿",
            fg=THEME["text_muted"],
            bg=THEME["header_bg"],
            font=self.font(14, "bold"),
            padx=self.px(4),
            cursor="fleur",
        )
        grip.pack(side="left")
        self._bind_draggable(grip)

        # Provider Coding Plan Pills
        pills_frame = tk.Frame(bar, bg=THEME["header_bg"])
        pills_frame.pack(side="left", padx=(self.px(2), self.px(6)))
        self._bind_draggable(pills_frame)

        if not self.snapshot.pills:
            empty_lbl = tk.Label(
                pills_frame,
                text="暂无配额缓存 · 点击 ⟳ 同步",
                fg=THEME["text_secondary"],
                bg=THEME["header_bg"],
                font=self.font(12),
                padx=self.px(8),
            )
            empty_lbl.pack(side="left")
            self._bind_draggable(empty_lbl)
        else:
            for pill in self.snapshot.pills:
                _, txt_fg, pill_bg, pill_border = quota_palette(pill.remaining_pct)
                p_wrap = tk.Frame(
                    pills_frame,
                    bg=pill_bg,
                    bd=0,
                    highlightthickness=1,
                    highlightbackground=pill_border,
                    cursor="hand2",
                )
                p_wrap.pack(side="left", padx=self.px(3))
                p_lbl = tk.Label(
                    p_wrap,
                    text=pill.format_text(now_ms, self.show_left),
                    fg=txt_fg,
                    bg=pill_bg,
                    font=self.font(11, "bold"),
                    padx=self.px(7),
                    pady=self.px(3),
                    cursor="hand2",
                )
                p_lbl.pack()
                self._mini_pill_targets.append((p_lbl, pill))

                def _open_full(_e: Any) -> None:
                    self.set_mode("full")

                p_wrap.bind("<ButtonRelease-1>", _open_full)
                p_lbl.bind("<ButtonRelease-1>", _open_full)

        # Thin vertical divider
        sep = tk.Frame(bar, bg=THEME["divider"], width=1)
        sep.pack(side="left", fill="y", padx=self.px(4), pady=self.px(3))

        # Action cluster: [⟳] [▾ 详单] [📌] [×]
        actions = tk.Frame(bar, bg=THEME["header_bg"])
        actions.pack(side="right")

        ref_wrap, ref_lbl = self._make_action_btn(
            actions,
            "…" if self.refreshing else "⟳",
            lambda: self.trigger_background_refresh(force=True),
            fg=THEME["cyan"] if self.refreshing else THEME["text_primary"],
            padx=6,
            pady=2,
            font_px=12,
            bold=True,
        )
        ref_wrap.pack(side="left", padx=self.px(2))
        self._refresh_btn_label = ref_lbl

        exp_wrap, _ = self._make_action_btn(
            actions,
            "▾ 详单",
            lambda: self.set_mode("full"),
            fg=THEME["text_primary"],
            padx=7,
            pady=2,
            font_px=11,
        )
        exp_wrap.pack(side="left", padx=self.px(2))

        pin_wrap, _ = self._make_action_btn(
            actions,
            "📌",
            self.toggle_topmost,
            fg=THEME["cyan"] if self.topmost else THEME["text_muted"],
            bg=THEME["btn_active_bg"] if self.topmost else THEME["btn_bg"],
            border_color=THEME["btn_active_border"] if self.topmost else THEME["divider"],
            padx=6,
            pady=2,
            font_px=11,
        )
        pin_wrap.pack(side="left", padx=self.px(2))

        cls_wrap, _ = self._make_action_btn(
            actions,
            "×",
            self.shutdown,
            fg=THEME["text_secondary"],
            hover_bg=THEME["btn_close_hover"],
            padx=7,
            pady=2,
            font_px=12,
            bold=True,
        )
        cls_wrap.pack(side="left", padx=(self.px(2), 0))

    # ─── ② Full Multi-Pool Dashboard Mode (`--full`) ──────────────────────────

    def _build_full_dashboard(self, now_ms: int) -> None:
        # 1. Header Bar
        header = tk.Frame(self.outer, bg=THEME["header_bg"], padx=self.px(12), pady=self.px(9))
        header.pack(fill="x")
        self._bind_draggable(header)

        title_box = tk.Frame(header, bg=THEME["header_bg"])
        title_box.pack(side="left", fill="x", expand=True)
        self._bind_draggable(title_box)

        dot = tk.Label(
            title_box,
            text="●",
            fg=THEME["cyan"],
            bg=THEME["header_bg"],
            font=self.font(11, "bold"),
            cursor="fleur",
        )
        dot.pack(side="left", padx=(0, self.px(5)))
        self._bind_draggable(dot)

        title_lbl = tk.Label(
            title_box,
            text="OMP Coding Plans 实时余量",
            fg=THEME["text_primary"],
            bg=THEME["header_bg"],
            font=self.font(13, "bold"),
            cursor="fleur",
        )
        title_lbl.pack(side="left")
        self._bind_draggable(title_lbl)

        fresh_lbl = tk.Label(
            title_box,
            text=format_freshness(self.snapshot.generated_at_ms, now_ms, self.refreshing),
            fg=THEME["cyan"] if self.refreshing else THEME["text_secondary"],
            bg=THEME["header_bg"],
            font=self.font(11),
            padx=self.px(7),
            cursor="fleur",
        )
        fresh_lbl.pack(side="left")
        self._bind_draggable(fresh_lbl)
        self._freshness_label = fresh_lbl

        # Header controls: [⟳ 强刷] [▴ 胶囊] [📌 置顶] [×]
        ctrl = tk.Frame(header, bg=THEME["header_bg"])
        ctrl.pack(side="right")

        ref_wrap, ref_lbl = self._make_action_btn(
            ctrl,
            "⟳ 刷新中" if self.refreshing else "⟳ 强刷",
            lambda: self.trigger_background_refresh(force=True),
            fg=THEME["cyan"] if self.refreshing else THEME["text_primary"],
            padx=6,
            pady=2,
            font_px=11,
        )
        ref_wrap.pack(side="left", padx=self.px(2))
        self._refresh_btn_label = ref_lbl

        pol_wrap, _ = self._make_action_btn(
            ctrl,
            "⇄ 剩余" if self.show_left else "⇄ 已用",
            self.toggle_polarity,
            fg=THEME["emerald_text"] if self.show_left else THEME["amber_text"],
            bg=THEME["btn_active_bg"],
            border_color=THEME["btn_active_border"],
            padx=6,
            pady=2,
            font_px=11,
        )
        pol_wrap.pack(side="left", padx=self.px(2))
        mini_wrap, _ = self._make_action_btn(
            ctrl,
            "▴ 胶囊",
            lambda: self.set_mode("mini"),
            fg=THEME["text_primary"],
            padx=6,
            pady=2,
            font_px=11,
        )
        mini_wrap.pack(side="left", padx=self.px(2))

        pin_wrap, _ = self._make_action_btn(
            ctrl,
            "📌 置顶",
            self.toggle_topmost,
            fg=THEME["cyan"] if self.topmost else THEME["text_muted"],
            bg=THEME["btn_active_bg"] if self.topmost else THEME["btn_bg"],
            border_color=THEME["btn_active_border"] if self.topmost else THEME["divider"],
            padx=6,
            pady=2,
            font_px=11,
        )
        pin_wrap.pack(side="left", padx=self.px(2))

        cls_wrap, _ = self._make_action_btn(
            ctrl,
            "×",
            self.shutdown,
            fg=THEME["text_secondary"],
            hover_bg=THEME["btn_close_hover"],
            padx=7,
            pady=2,
            font_px=12,
            bold=True,
        )
        cls_wrap.pack(side="left", padx=(self.px(2), 0))

        tk.Frame(self.outer, bg=THEME["divider"], height=1).pack(fill="x")

        # 2. Quick Preset Switcher Section
        if self.config_state.presets:
            preset_sec = tk.Frame(self.outer, bg=THEME["sub_bg"], padx=self.px(12), pady=self.px(8))
            preset_sec.pack(fill="x")

            p_hdr = tk.Frame(preset_sec, bg=THEME["sub_bg"])
            p_hdr.pack(fill="x", pady=(0, self.px(6)))

            tk.Label(
                p_hdr,
                text="⚡ 场景预设一键切换 (config.yml)",
                fg=THEME["text_secondary"],
                bg=THEME["sub_bg"],
                font=self.font(11, "bold"),
            ).pack(side="left")

            show_toast = self.toast_text and now_ms <= self.toast_until_ms
            status_txt = (
                self.toast_text
                if show_toast
                else (
                    f"当前: {self.config_state.active_preset}"
                    if self.config_state.active_preset
                    else "当前: 自定义矩阵"
                )
            )
            toast_lbl = tk.Label(
                p_hdr,
                text=status_txt,
                fg=THEME["cyan"] if show_toast else THEME["text_secondary"],
                bg=THEME["sub_bg"],
                font=self.font(11),
            )
            toast_lbl.pack(side="right")
            self._toast_label = toast_lbl

            grid = tk.Frame(preset_sec, bg=THEME["sub_bg"])
            grid.pack(fill="x")
            grid.grid_columnconfigure(0, weight=1, uniform="preset_col")
            grid.grid_columnconfigure(1, weight=1, uniform="preset_col")

            for idx, (pname, pdef) in enumerate(self.config_state.presets.items()):
                r, c = divmod(idx, 2)
                is_active = pname == self.config_state.active_preset
                bg_c = THEME["btn_active_bg"] if is_active else THEME["btn_bg"]
                bd_c = THEME["btn_active_border"] if is_active else THEME["card_border"]
                fg_c = THEME["cyan"] if is_active else THEME["text_primary"]

                cell = tk.Frame(
                    grid,
                    bg=bg_c,
                    bd=0,
                    highlightthickness=1,
                    highlightbackground=bd_c,
                    padx=self.px(8),
                    pady=self.px(5),
                    cursor="hand2",
                )
                cell.grid(
                    row=r,
                    column=c,
                    sticky="ew",
                    padx=(0 if c == 0 else self.px(4), self.px(4) if c == 0 else 0),
                    pady=self.px(2),
                )

                top_txt = f"{'●' if is_active else '○'} {pname}"
                l1 = tk.Label(
                    cell,
                    text=top_txt,
                    fg=fg_c,
                    bg=bg_c,
                    font=self.font(11, "bold"),
                    anchor="w",
                    cursor="hand2",
                )
                l1.pack(fill="x")

                l2 = tk.Label(
                    cell,
                    text=pdef.summary_subtitle(),
                    fg=THEME["text_secondary"] if is_active else THEME["text_muted"],
                    bg=bg_c,
                    font=self.font(10),
                    anchor="w",
                    cursor="hand2",
                )
                l2.pack(fill="x")

                self._bind_preset_button(cell, (l1, l2), pname, is_active, bg_c)

            tk.Frame(self.outer, bg=THEME["divider"], height=1).pack(fill="x")

        # 3. Footer Summary Bar (pack bottom before expandable scroll canvas)
        expiring_count = sum(
            1
            for card in self.snapshot.cards
            for w in card.windows
            if not w.is_auxiliary and w.is_expiring_priority(now_ms)
        )
        footer_sep = tk.Frame(self.outer, bg=THEME["divider"], height=1)
        footer_sep.pack(side="bottom", fill="x")

        footer = tk.Frame(self.outer, bg=THEME["header_bg"], padx=self.px(12), pady=self.px(5))
        footer.pack(side="bottom", fill="x")
        self._bind_draggable(footer)

        summary_txt = f"{len(self.snapshot.providers)} 厂商 · {len(self.snapshot.cards)} 账号池"
        if expiring_count > 0:
            summary_txt += f" · 🔥 {expiring_count} 临期优先"
        f_left = tk.Label(
            footer,
            text=summary_txt,
            fg=THEME["text_secondary"],
            bg=THEME["header_bg"],
            font=self.font(10),
        )
        f_left.pack(side="left")
        self._bind_draggable(f_left)

        f_right = tk.Label(
            footer,
            text="滚轮浏览 · 拖动标题栏移动",
            fg=THEME["text_muted"],
            bg=THEME["header_bg"],
            font=self.font(10),
        )
        f_right.pack(side="right")
        self._bind_draggable(f_right)

        # 4. Scrollable Pool Cards Viewport (with custom dark slim scroll indicator)
        body = tk.Frame(self.outer, bg=THEME["bg"])
        body.pack(side="top", fill="both", expand=True)

        thumb_canvas = tk.Canvas(
            body,
            width=self.px(6),
            bg=THEME["bg"],
            bd=0,
            highlightthickness=0,
        )
        thumb_canvas.pack(side="right", fill="y", padx=(0, self.px(3)), pady=self.px(6))
        self._scroll_thumb_canvas = thumb_canvas

        canvas = tk.Canvas(
            body,
            bg=THEME["bg"],
            bd=0,
            highlightthickness=0,
            yscrollincrement=self.px(18),
        )
        canvas.pack(side="left", fill="both", expand=True)
        self._cards_canvas = canvas

        inner = tk.Frame(canvas, bg=THEME["bg"], padx=self.px(10), pady=self.px(8))
        win_id = canvas.create_window((0, 0), window=inner, anchor="nw")
        self._cards_window_id = win_id

        def _update_scroll_thumb(*args: Any) -> None:
            if self._scroll_thumb_canvas is None:
                return
            tc = self._scroll_thumb_canvas
            tc.delete("all")
            try:
                lo, hi = float(args[0]), float(args[1])
            except Exception:
                lo, hi = canvas.yview()
            if hi - lo >= 0.999:
                return
            ch = max(20, tc.winfo_height())
            cw = max(4, tc.winfo_width())
            y1 = int(lo * ch)
            y2 = max(y1 + self.px(24), int(hi * ch))
            tc.create_rectangle(1, y1, cw - 1, min(ch, y2), fill="#29436b", outline="")

        canvas.configure(yscrollcommand=_update_scroll_thumb)

        def _on_inner_configure(_e: Any) -> None:
            canvas.configure(scrollregion=canvas.bbox("all"))
            lo, hi = canvas.yview()
            _update_scroll_thumb(lo, hi)

        def _on_canvas_configure(ev: Any) -> None:
            canvas.itemconfigure(win_id, width=ev.width)
            lo, hi = canvas.yview()
            _update_scroll_thumb(lo, hi)

        inner.bind("<Configure>", _on_inner_configure)
        canvas.bind("<Configure>", _on_canvas_configure)

        if not self.snapshot.cards:
            empty = tk.Label(
                inner,
                text="未读取到配额报告\n点击右上角 [⟳ 强刷] 执行 omp usage --json",
                fg=THEME["text_secondary"],
                bg=THEME["bg"],
                font=self.font(12),
                pady=self.px(36),
                justify="center",
            )
            empty.pack(fill="x")
        else:
            for card in self.snapshot.cards:
                self._build_pool_card(inner, card, now_ms)

    def _bind_preset_button(
        self,
        cell: tk.Frame,
        labels: tuple[tk.Label, ...],
        preset_name: str,
        is_active: bool,
        base_bg: str,
    ) -> None:
        hover_bg = THEME["btn_active_bg"] if is_active else THEME["btn_hover"]

        def _enter(_e: Any) -> None:
            cell.configure(bg=hover_bg)
            for l_w in labels:
                l_w.configure(bg=hover_bg)

        def _leave(_e: Any) -> None:
            cell.configure(bg=base_bg)
            for l_w in labels:
                l_w.configure(bg=base_bg)

        def _click(_e: Any) -> None:
            self.switch_model_preset(preset_name)

        for w in (cell, *labels):
            w.bind("<Enter>", _enter)
            w.bind("<Leave>", _leave)
            w.bind("<ButtonRelease-1>", _click)

    def _build_pool_card(self, parent: tk.Widget, card: PoolCardData, now_ms: int) -> None:
        is_expiring = card.has_expiring_priority(now_ms)
        is_exhausted = card.primary_pct <= 0.05
        bar_color, pct_fg, pct_bg, pct_bd = quota_palette(card.primary_pct)

        card_bg = THEME["card_exhausted_bg"] if is_exhausted else THEME["card_bg"]
        card_bd = THEME["card_expiring_border"] if is_expiring else THEME["card_border"]

        outer_card = tk.Frame(
            parent,
            bg=card_bg,
            bd=0,
            highlightthickness=1,
            highlightbackground=card_bd,
        )
        outer_card.pack(fill="x", pady=self.px(4))

        # Left 3px vertical semantic accent bar
        accent_color = THEME["amber"] if is_expiring else bar_color
        accent = tk.Frame(outer_card, bg=accent_color, width=self.px(3))
        accent.pack(side="left", fill="y")

        content = tk.Frame(outer_card, bg=card_bg, padx=self.px(10), pady=self.px(8))
        content.pack(side="left", fill="both", expand=True)

        # Card Header Row
        hdr = tk.Frame(content, bg=card_bg)
        hdr.pack(fill="x", pady=(0, self.px(5)))

        left_hdr = tk.Frame(hdr, bg=card_bg)
        left_hdr.pack(side="left", fill="x", expand=True)

        tk.Label(
            left_hdr,
            text=card.provider_name,
            fg=THEME["text_primary"] if not is_exhausted else THEME["text_secondary"],
            bg=card_bg,
            font=self.font(12, "bold"),
        ).pack(side="left")

        if card.account_subtitle:
            sub_txt = card.account_subtitle
            if len(sub_txt) > 30:
                sub_txt = sub_txt[:29] + "…"
            tk.Label(
                left_hdr,
                text=sub_txt,
                fg=THEME["text_muted"],
                bg=card_bg,
                font=self.font(10),
                padx=self.px(6),
            ).pack(side="left")

        right_hdr = tk.Frame(hdr, bg=card_bg)
        right_hdr.pack(side="right")

        if is_expiring:
            fire_badge = tk.Label(
                right_hdr,
                text="🔥 临期优先",
                fg=THEME["amber_text"],
                bg=THEME["amber_bg"],
                font=self.font(10, "bold"),
                padx=self.px(6),
                pady=self.px(1),
            )
            fire_badge.pack(side="left", padx=(0, self.px(4)))

        if card.reset_credits > 0:
            cred_badge = tk.Label(
                right_hdr,
                text=f"✦{card.reset_credits} 重置券",
                fg=THEME["cyan"],
                bg=THEME["cyan_bg"],
                font=self.font(10, "bold"),
                padx=self.px(6),
                pady=self.px(1),
            )
            cred_badge.pack(side="left", padx=(0, self.px(4)))

        card_shown_pct = card.primary_pct if self.show_left else max(0.0, 100.0 - card.primary_pct)
        pct_str = f"{card_shown_pct:.0f}%" if card_shown_pct in (0.0, 100.0) else f"{card_shown_pct:.1f}%"
        pct_wrap = tk.Frame(right_hdr, bg=pct_bg, highlightthickness=1, highlightbackground=pct_bd)
        pct_wrap.pack(side="left")
        tk.Label(
            pct_wrap,
            text=f"{'剩余' if self.show_left else '已用'} {pct_str}",
            fg=pct_fg,
            bg=pct_bg,
            font=self.font(11, "bold"),
            padx=self.px(6),
            pady=self.px(1),
            cursor="hand2",
        ).pack()

        # Window Rows + Smooth Canvas Progress Bars
        for w in card.windows:
            w_frame = tk.Frame(content, bg=card_bg)
            w_frame.pack(fill="x", pady=(self.px(3), self.px(1)))

            top_row = tk.Frame(w_frame, bg=card_bg)
            top_row.pack(fill="x")

            w_exp = w.is_expiring_priority(now_ms)
            w_bar_color, w_txt_fg, _, _ = quota_palette(w.remaining_pct)
            if w_exp and w.remaining_pct >= 60.0:
                # Keep emerald or highlight subtle warm amber indicator next to title
                title_text = f"🔥 {w.display_label}"
            else:
                title_text = w.display_label

            tk.Label(
                top_row,
                text=title_text,
                fg=THEME["amber_text"] if w_exp else (THEME["text_secondary"] if not w.is_auxiliary else THEME["text_muted"]),
                bg=card_bg,
                font=self.font(11, "bold" if w_exp else "normal"),
                anchor="w",
            ).pack(side="left")

            shown_w_pct = w.remaining_pct if self.show_left else max(0.0, 100.0 - w.remaining_pct)
            pol_prefix = "剩余" if self.show_left else "已用"
            w_pct_num = f"{shown_w_pct:.0f}%" if shown_w_pct in (0.0, 100.0) else f"{shown_w_pct:.1f}%"
            tk.Label(
                top_row,
                text=f"{pol_prefix} {w_pct_num}",
                fg=w_txt_fg,
                bg=card_bg,
                font=self.font(11, "bold"),
            ).pack(side="right", padx=(self.px(6), 0))

            if w.remaining_pct >= 99.95:
                tk.Label(
                    top_row,
                    text="未使用",
                    fg=THEME["text_muted"],
                    bg=card_bg,
                    font=self.font(10),
                ).pack(side="right")
            elif w.resets_at_ms:
                cd_txt = format_countdown_full(w.resets_at_ms, now_ms)
                # Magpie Pace delta when window duration & reset are known
                if w.duration_ms > 0 and 0 < (w.resets_at_ms - now_ms) < w.duration_ms:
                    elapsed_f = 1.0 - ((w.resets_at_ms - now_ms) / w.duration_ms)
                    if elapsed_f >= 0.05:
                        used_f = 1.0 - w.remaining_frac
                        pace_diff = int(round((used_f - elapsed_f) * 100))
                        if abs(pace_diff) >= 8:
                            disp_diff = -pace_diff if self.show_left else pace_diff
                            sign = "+" if disp_diff > 0 else "−"
                            cd_txt = f"{cd_txt} · 配速 {sign}{abs(disp_diff)}%"
                cd_lbl = tk.Label(
                    top_row,
                    text=cd_txt,
                    fg=THEME["amber_text"] if w_exp else THEME["text_muted"],
                    bg=card_bg,
                    font=self.font(10),
                )
                cd_lbl.pack(side="right")
                self._countdown_targets.append((cd_lbl, w.resets_at_ms))

            bar_h = self.px(6)
            bar_cv = tk.Canvas(
                w_frame,
                height=bar_h,
                bg=THEME["track_bg"],
                bd=0,
                highlightthickness=0,
            )
            bar_cv.pack(fill="x", pady=(self.px(2), self.px(1)))

            frac = max(0.0, min(1.0, w.remaining_frac if self.show_left else (1.0 - w.remaining_frac)))

            def _paint_bar(ev: Any, cv: tk.Canvas = bar_cv, f: float = frac, col: str = fill_c) -> None:
                cv.delete("all")
                bw = max(1, int(ev.width))
                bh = max(1, int(ev.height))
                cv.create_rectangle(0, 0, bw, bh, fill=THEME["track_bg"], outline="")
                if f > 0.002:
                    fw = max(2, int(round(bw * f)))
                    cv.create_rectangle(0, 0, min(bw, fw), bh, fill=col, outline="")

            bar_cv.bind("<Configure>", _paint_bar)

    def _on_mousewheel(self, event: tk.Event[Any]) -> None:
        if self.mode != "full" or self._cards_canvas is None:
            return
        try:
            lo, hi = self._cards_canvas.yview()
            if hi - lo >= 0.999:
                return
            steps = -int(event.delta / 120) * 3
            if steps != 0:
                self._cards_canvas.yview_scroll(steps, "units")
        except Exception:
            pass

    def run(self) -> None:
        try:
            self.root.mainloop()
        finally:
            self._remove_socket_state()


# ─── CLI Entrypoint ───────────────────────────────────────────────────────────


def build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="omp-quota-hud",
        description="OMP Coding Plans Standalone Desktop Floating HUD",
    )
    mode_group = p.add_mutually_exclusive_group()
    mode_group.add_argument("--open", action="store_true", help="Start HUD or bring running instance to front (default)")
    mode_group.add_argument("--toggle", action="store_true", help="Toggle HUD visibility (or start if not running)")
    mode_group.add_argument("--mini", action="store_true", help="Switch HUD to compact Mini Capsule Strip mode")
    mode_group.add_argument("--full", action="store_true", help="Switch HUD to Full Multi-Pool Dashboard mode")
    mode_group.add_argument("--refresh", action="store_true", help="Trigger background live `omp usage --json` refresh")
    mode_group.add_argument("--close", action="store_true", help="Gracefully close running HUD instance")
    mode_group.add_argument("--status", action="store_true", help="Print live JSON status of HUD instance")

    # Internal daemon flags
    p.add_argument("--replace-legacy", action="store_true", help="Stop legacy quota-popup.pid if running")
    p.add_argument("--daemon", action="store_true", help=argparse.SUPPRESS)
    p.add_argument("--foreground", action="store_true", help="Run HUD event loop in foreground process")
    p.add_argument("--initial-mode", choices=["mini", "full"], default=None, help=argparse.SUPPRESS)
    return p


def _emit_json(data: dict[str, Any]) -> None:
    if _HAS_REAL_STDOUT and sys.stdout is not None:
        try:
            sys.stdout.write(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
            sys.stdout.flush()
        except Exception:
            pass


def main(argv: list[str] | None = None) -> int:
    parser = build_arg_parser()
    args = parser.parse_args(argv)

    if args.replace_legacy:
        terminate_legacy_quota_popup_if_requested()

    # Determine requested action
    if args.status:
        action = "status"
    elif args.close:
        action = "close"
    elif args.refresh:
        action = "refresh"
    elif args.toggle:
        action = "toggle"
    elif args.mini:
        action = "mini"
    elif args.full:
        action = "full"
    else:
        action = "open"

    # Internal background daemon process entry
    if args.daemon or args.foreground:
        existing = send_control_command("status", timeout=0.35)
        if existing and existing.get("running") is True:
            cmd_to_send = args.initial_mode if args.initial_mode in ("mini", "full") else "open"
            send_control_command(cmd_to_send, timeout=0.6)
            return 0
        init_mode = args.initial_mode
        if init_mode is None and action in ("mini", "full"):
            init_mode = action
        app = OmpQuotaHudApp(initial_mode=init_mode)
        app.run()
        return 0

    # Fast single-instance client path (< 50 ms when HUD is already running)
    if action == "status":
        resp = send_control_command("status", timeout=0.6)
        if resp and resp.get("running") is True:
            _emit_json(resp)
        else:
            # Clean stale socket file if dead
            if SOCKET_STATE_PATH.exists():
                try:
                    SOCKET_STATE_PATH.unlink(missing_ok=True)
                except OSError:
                    pass
            _emit_json({"ok": True, "running": False})
        return 0

    if action == "close":
        resp = send_control_command("close", timeout=0.8)
        if resp:
            _emit_json(resp)
        return 0

    if action == "refresh":
        # Quietly no-op and exit 0 if HUD is not running (harmonized with TUI `/quota refresh`)
        resp = send_control_command("refresh", timeout=0.8)
        if resp:
            _emit_json(resp)
        return 0

    # action in ("open", "toggle", "mini", "full")
    resp = send_control_command(action, timeout=0.8)
    if resp and resp.get("ok") is True:
        return 0

    # Not running yet -> spawn detached pythonw daemon and return immediately once socket is ready
    init_mode = action if action in ("mini", "full") else None
    ok = spawn_detached_hud_daemon(initial_mode=init_mode)
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
