"""Where outputs and caches live. The motion library is the folder the desktop app reads."""
from __future__ import annotations

import os
import sys
from pathlib import Path


def app_data_dir() -> Path:
    """Same folder as Electron's app.getPath('userData') for the app named "desktop-dancer".
    The app passes its exact folder in DANCER_DATA_DIR when it runs the pipeline."""
    if os.environ.get("DANCER_DATA_DIR"):
        return Path(os.environ["DANCER_DATA_DIR"])
    if sys.platform == "win32":
        base = Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming"))
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        base = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))
    return base / "desktop-dancer"


def motions_dir() -> Path:
    return app_data_dir() / "library" / "motions"


def cache_dir() -> Path:
    return app_data_dir() / "pipeline-cache"
