"""Resources used by the release UI; obsolete design variants are not shipped."""
from pathlib import Path

WEB_FILES = (
    "index.html", "style.css", "frames.css", "app.js", "icon-theme.js",
    "draft-codec.js", "draft-worker.js", "avatar.webp", "mascot.webp",
    "reading.webp", "favicon.png", "favicon.ico", "btn-dots.svg",
    "icons/nav-menu-idle-v5.png", "icons/nav-menu-active-v5.png",
    "icons/nav-browse-idle-v6.png", "icons/nav-browse-active-v6.png",
    "icons/nav-transfer-idle-v5.png", "icons/nav-transfer-active-v5.png",
    "icons/organize-start-v3.png", "icons/organize-finish-v3.png",
)

def web_paths(root: Path):
    for name in WEB_FILES:
        path = root / "bilifav/web" / name
        if not path.is_file():
            raise FileNotFoundError(path)
        yield path
