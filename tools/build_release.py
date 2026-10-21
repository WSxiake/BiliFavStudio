"""Build a clean portable ZIP and a Windows installer from the latest desktop build.

Run after PyInstaller: python tools/build_release.py
Only program resources and documentation are included; user data is excluded.
"""
from __future__ import annotations

import hashlib
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import uuid
from zipfile import ZipFile, ZIP_DEFLATED
from release_assets import web_paths

ROOT = Path(__file__).resolve().parents[1]
APP = "BiliFav Studio"
SOURCE = ROOT / "dist_new" / APP
TAG = "v1.0.0"
OUT = ROOT / "release" / TAG


def zip_tree(folder: Path, output: Path, prefix: str = "") -> None:
    with ZipFile(output, "w", ZIP_DEFLATED, compresslevel=9) as archive:
        for file in sorted(folder.rglob("*")):
            if file.is_file():
                name = file.relative_to(folder).as_posix()
                archive.write(file, prefix + name)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=SOURCE)
    source = parser.parse_args().source.resolve()
    compiler = Path(os.environ.get("WINDIR", r"C:\Windows")) / "Microsoft.NET/Framework64/v4.0.30319/csc.exe"
    if not compiler.is_file() or not (source / f"{APP}.exe").is_file():
        raise SystemExit("缺少 Windows 编译器或最新桌面程序。")
    work = ROOT / ".perf" / ("release-" + TAG + "-" + uuid.uuid4().hex[:8])
    stage = work / APP
    stage.mkdir(parents=True)
    OUT.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source / f"{APP}.exe", stage / f"{APP}.exe")
    shutil.copytree(source / "_internal", stage / "_internal",
                    ignore=lambda folder, names: names if Path(folder) == source / "_internal/bilifav/web" else [])
    for file in web_paths(ROOT):
        target = stage / "_internal/bilifav/web" / file.relative_to(ROOT / "bilifav/web")
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(file, target)
    shutil.copyfile(ROOT / "docs/使用教程.md", stage / "使用教程.md")
    (stage / "使用说明.txt").write_text(
        "BiliFav Studio v1.0.0 · 首次公开发布\n\n"
        "免安装版：先完整解压，再双击 BiliFav Studio.exe。不要只取出 exe。\n"
        "安装版：运行安装程序，可选择安装位置和是否创建桌面快捷方式。\n"
        "详细说明见 使用教程.md。\n\n"
        "登录信息、草稿和任务记录保存在程序旁的 data 文件夹。\n"
        "更新前请退出正在运行的软件；覆盖程序文件时保留原来的 data 文件夹。\n"
        "本包不含任何账号、登录信息或个人数据。\n",
        encoding="utf-8-sig",
    )
    # Verify every production frontend asset, not just the entry HTML.
    for file in web_paths(ROOT):
        bundled = source / "_internal/bilifav/web" / file.relative_to(ROOT / "bilifav/web")
        if not bundled.is_file() or bundled.read_bytes() != file.read_bytes():
            raise SystemExit(f"桌面资源过期：{file}")
    if (stage / "data").exists():
        raise SystemExit("发布目录中不应含用户 data。")
    portable = OUT / f"BiliFav-Studio-免安装-{TAG}.zip"
    installer = OUT / f"BiliFav-Studio-安装包-{TAG}.exe"
    payload = work / "payload.zip"
    zip_tree(stage, portable, APP + "/")
    zip_tree(stage, payload)
    subprocess.run([
        str(compiler), "/nologo", "/target:winexe", "/optimize+", "/platform:anycpu",
        f"/out:{installer}", f"/win32icon:{ROOT / 'assets/icon.ico'}",
        f"/resource:{payload},payload.zip",
        "/reference:System.dll", "/reference:System.Drawing.dll",
        "/reference:System.Windows.Forms.dll", "/reference:System.IO.Compression.dll",
        "/reference:System.IO.Compression.FileSystem.dll",
        str(ROOT / "tools/installer/Setup.cs"),
    ], check=True)
    with ZipFile(portable) as archive, ZipFile(payload) as embedded:
        assert archive.testzip() is None and embedded.testzip() is None
        expected = {p.relative_to(stage).as_posix() for p in stage.rglob("*") if p.is_file()}
        assert set(embedded.namelist()) == expected
        assert {name.removeprefix(APP + "/") for name in archive.namelist()} == expected
        for name in expected:
            assert archive.read(APP + "/" + name) == embedded.read(name)
    manifest = {
        "build": TAG, "source": str(source), "work": str(work), "payload": str(payload),
        "stage": str(stage), "files": len(expected),
        "outputs": [{"name": p.name, "bytes": p.stat().st_size,
                     "sha256": hashlib.sha256(p.read_bytes()).hexdigest()}
                    for p in (installer, portable)],
    }
    (work / "构建记录.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    (ROOT / ".perf/latest-release.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
