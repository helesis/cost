"""
Arka planda `python -m nutrition_service.sync_ingredients` sürecini yönetir.

- Çift başlatmayı flock + süreç PID ile engeller; ölmüş süreç için stale state temizler.
- sync_ingredients kaynak koduna dokunulmaz.
"""

from __future__ import annotations

import fcntl
import json
import os
import signal
import subprocess
import sys
import threading
import time
from collections import deque
from pathlib import Path
from typing import Any

from nutrition_service import db

_REPO_ROOT = Path(__file__).resolve().parent.parent
_LOCK_PATH = Path(os.environ.get("NUTRITION_SYNC_LOCK", "/tmp/nutrition_sync.lock"))
_STATE_PATH = Path(os.environ.get("NUTRITION_SYNC_STATE", "/tmp/nutrition_sync_state.json"))
_LOG_TAIL = 160

_STAGE_B_PENDING_COUNT_SQL = """
SELECT COUNT(*)::int AS n
FROM fb_cost.ingredient_nutrition
WHERE eslesme_durumu = 'eslesmedi'
  AND (
    son_arama_tarihi IS NULL
    OR urun_adi IS DISTINCT FROM son_arama_urun_adi
  )
"""

_thread_lock = threading.Lock()
_supervisor_proc: subprocess.Popen[str] | None = None
_log_lines: deque[str] = deque(maxlen=_LOG_TAIL)
_lock_holder_fd: int | None = None


def _pid_alive(pid: int) -> bool:
    if pid is None or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def _atomic_write_json(path: Path, obj: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    raw = json.dumps(obj, ensure_ascii=False, indent=2) + "\n"
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(raw, encoding="utf-8")
    os.replace(tmp, path)


def _read_state_json() -> dict[str, Any] | None:
    if not _STATE_PATH.is_file():
        return None
    try:
        return json.loads(_STATE_PATH.read_text(encoding="utf-8"))
    except Exception:
        return None


def _clear_state_file() -> None:
    try:
        _STATE_PATH.unlink(missing_ok=True)
    except OSError:
        pass


def _release_file_lock() -> None:
    global _lock_holder_fd
    fd = _lock_holder_fd
    _lock_holder_fd = None
    if fd is not None:
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        except OSError:
            pass
        try:
            os.close(fd)
        except OSError:
            pass


def _clear_dead_state_disk() -> None:
    """State dosyasındaki PID artık yoksa dosyayı kaldır (flock ayrı süreç ölünce zaten çözülür)."""
    st = _read_state_json()
    if not st:
        return
    pid = int(st.get("pid") or 0)
    if pid and not _pid_alive(pid):
        _clear_state_file()


def _try_acquire_exclusive_flock_nb() -> int | None:
    """
    /tmp nutrition_sync.lock üzerinde bloklamayan exclusive flock.
    Başarı: açık fd döner (job bitene kadar açık kalmalı).
    """
    _clear_dead_state_disk()
    _LOCK_PATH.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(str(_LOCK_PATH), os.O_CREAT | os.O_RDWR, 0o644)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return fd
    except BlockingIOError:
        os.close(fd)
        st = _read_state_json()
        if st and _pid_alive(int(st.get("pid") or 0)):
            return None
        # Başka worker geçmişte düşmüş olabilir; bir kez yeniden dene
        fd2 = os.open(str(_LOCK_PATH), os.O_CREAT | os.O_RDWR, 0o644)
        try:
            fcntl.flock(fd2, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return fd2
        except BlockingIOError:
            os.close(fd2)
            return None


def _count_stage_b_pending() -> int:
    row = db.fetch_one(_STAGE_B_PENDING_COUNT_SQL)
    if not row or row.get("n") is None:
        return 0
    return int(row["n"])


def _drain_stdout(proc: subprocess.Popen[str]) -> None:
    if not proc.stdout:
        return
    try:
        for line in proc.stdout:
            txt = line.rstrip("\r\n") if isinstance(line, str) else ""
            _log_lines.append(txt)
    except Exception:
        pass


def _job_finalize() -> None:
    global _supervisor_proc
    _supervisor_proc = None
    _release_file_lock()
    _clear_state_file()


def _spawn_and_record_state() -> subprocess.Popen[str]:
    bekleyen = _count_stage_b_pending()
    bas_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    argv = [sys.executable, "-u", "-m", "nutrition_service.sync_ingredients"]
    proc = subprocess.Popen(
        argv,
        cwd=str(_REPO_ROOT),
        env=os.environ.copy(),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        stdin=subprocess.DEVNULL,
        start_new_session=True,
    )
    st = {"pid": proc.pid, "baslangic_zamani": bas_iso, "bekleyen_baseline": bekleyen}
    _atomic_write_json(_STATE_PATH, st)
    _log_lines.append(
        f"[sync] PID={proc.pid} başladı cwd={_REPO_ROOT} bekleyen_baseline≈{bekleyen}"
    )

    threading.Thread(target=_drain_stdout, args=(proc,), daemon=True).start()

    def _watch() -> None:
        try:
            proc.wait(timeout=None)
        except Exception:
            pass
        finally:
            global _supervisor_proc
            with _thread_lock:
                # Aynı proc referansıysa finalize
                if _supervisor_proc is proc:
                    _job_finalize()

    threading.Thread(target=_watch, daemon=True).start()
    return proc


def sync_start() -> dict[str, Any]:
    global _supervisor_proc, _lock_holder_fd
    _clear_dead_state_disk()

    with _thread_lock:
        if _supervisor_proc is not None and _pid_alive(_supervisor_proc.pid):
            return {"started": False, "reason": "zaten çalışıyor"}

        st = _read_state_json()
        if st and _pid_alive(int(st.get("pid") or 0)):
            return {"started": False, "reason": "zaten çalışıyor"}

        if _lock_holder_fd is not None:
            _release_file_lock()

        fd = _try_acquire_exclusive_flock_nb()
        if fd is None:
            return {"started": False, "reason": "zaten çalışıyor"}

        _lock_holder_fd = fd

        try:
            _supervisor_proc = _spawn_and_record_state()
        except Exception as e:
            _job_finalize()
            return {"started": False, "reason": f"Başlatma hatası: {e}"}

        return {"started": True}


def sync_stop() -> dict[str, Any]:
    """Çalışan sync sürecini (process group) sonlandırır."""
    global _supervisor_proc

    _clear_dead_state_disk()
    proc = None
    with _thread_lock:
        proc = _supervisor_proc
        pid = proc.pid if proc else None

    if not pid or not _pid_alive(pid):
        disk = _read_state_json()
        dp = int((disk.get("pid") if disk else 0) or 0)
        if dp and _pid_alive(dp):
            try:
                os.killpg(dp, signal.SIGTERM)
            except (ProcessLookupError, PermissionError, OSError):
                try:
                    os.kill(dp, signal.SIGTERM)
                except OSError:
                    pass
            _log_lines.append("[sync] Dış PID üzerinden durdurma gönderildi")
            return {"stopped": True, "pid": dp}
        return {"stopped": False, "reason": "çalışan iş yok"}

    try:
        os.killpg(pid, signal.SIGTERM)
    except ProcessLookupError:
        try:
            if proc:
                proc.terminate()
        except ProcessLookupError:
            pass

    deadline = time.time() + 15
    while proc and proc.poll() is None and time.time() < deadline:
        time.sleep(0.25)
    if proc and proc.poll() is None:
        try:
            os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError:
            try:
                proc.kill()
            except ProcessLookupError:
                pass

    _log_lines.append("[sync] Durdur sinyali uygulandı")
    return {"stopped": True, "pid": pid}


def sync_status() -> dict[str, Any]:
    _clear_dead_state_disk()
    kalan = _count_stage_b_pending()

    proc_live = False
    live_pid = None
    with _thread_lock:
        p = _supervisor_proc
        if p is not None and _pid_alive(p.pid):
            proc_live = True
            live_pid = p.pid

    st = _read_state_json()
    disk_pid = int((st.get("pid") if st else 0) or 0) if isinstance(st, dict) else 0

    pid_effective = live_pid if proc_live else (disk_pid if _pid_alive(disk_pid) else None)
    calisiyor = bool(pid_effective)

    baseline = None
    if st and isinstance(st.get("bekleyen_baseline"), int):
        baseline = int(st["bekleyen_baseline"])

    if baseline is None and calisiyor:
        baseline = kalan

    islenen = 0
    if baseline is not None:
        islenen = max(0, int(baseline) - int(kalan))

    baslangic = None
    if calisiyor:
        baslangic = (st.get("baslangic_zamani") if isinstance(st, dict) else None) or None

    son_log = _log_lines[-1][:4000] if _log_lines else None

    return {
        "calisiyor": calisiyor,
        "baslangic_zamani": baslangic,
        "islenen_sayisi": islenen,
        "kalan_sayisi": kalan,
        "baslangictaki_kuyruk": baseline,
        "pid": pid_effective,
        "son_log": son_log,
    }
