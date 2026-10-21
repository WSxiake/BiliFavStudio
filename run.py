# -*- coding: utf-8 -*-
"""
BiliFav Studio 启动入口。

双击「启动.bat」就是用这个文件把服务拉起来的。
想换端口、不想自动开浏览器，可以自己加参数：
    python run.py --port 9000 --no-browser
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

# 保证从任何目录调用都能找到 bilifav 包
sys.path.insert(0, str(Path(__file__).resolve().parent))

# 中文 Windows 的控制台是 GBK，输出里混进 emoji 或生僻符号会直接
# 抛 UnicodeEncodeError 把程序搞崩。这里统一降级成替换字符，宁可显示成
# "?" 也不能崩。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(errors="replace")
    except (AttributeError, ValueError):
        pass


def check_environment() -> bool:
    """启动前先看一眼环境，缺什么就直说，别等用户一脸问号。"""
    if sys.version_info < (3, 8):
        print("[X] Python 版本太老了，至少要 3.8（当前 %s）" % sys.version.split()[0])
        return False
    try:
        import requests  # noqa: F401
    except ImportError:
        print("[X] 缺少依赖库 requests。")
        print()
        print("  在本目录下执行这一句就能装上：")
        print("      python -m pip install requests")
        print()
        print("  如果下载慢，可以换国内源：")
        print("      python -m pip install requests -i https://pypi.tuna.tsinghua.edu.cn/simple")
        return False
    return True


def main() -> int:
    parser = argparse.ArgumentParser(
        prog="BiliFav Studio",
        description="B 站收藏夹搬运与顺序整理工具",
    )
    parser.add_argument(
        "--port", type=int, default=0,
        help="本地服务端口。默认 0 = 让系统随机分配一个空闲端口；"
             "想固定的话就指定一个，被占用会自动往后顺延",
    )
    parser.add_argument("--host", default="127.0.0.1", help="监听地址（默认只监听本机，别乱改）")
    parser.add_argument("--no-browser", action="store_true", help="启动后不自动打开浏览器")
    parser.add_argument("--quiet", action="store_true", help="少打点字")
    args = parser.parse_args()

    if not check_environment():
        return 1

    from bilifav.server import serve

    try:
        serve(
            host=args.host,
            port=args.port,
            open_browser=not args.no_browser,
            quiet=args.quiet,
        )
    except OSError as exc:
        print(f"[X] 起不来了：{exc}")
        return 1
    except Exception as exc:  # noqa: BLE001
        print(f"[X] 出了点意外：{type(exc).__name__}: {exc}")
        return 1
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\n拜拜～下次再来找本鲸玩")
