# -*- coding: utf-8 -*-
"""
BiliFav Studio 桌面版入口。

双击就是一个原生窗口 —— 没有浏览器地址栏、没有标签页、没有黑框框。
底层还是那套「本地服务 + 网页界面」，只是装进了一个正常的应用窗口里。

开窗口有三条路，从上往下试：

  ① **真原生窗口**（pywebview + Edge WebView2）
     最像桌面软件。但它要求机器上装有 WebView2 运行时，
     而且 pywebview 在 Windows 上是靠 pythonnet 去驱动 .NET 的 ——
     那层对 .NET 运行时的版本挺挑，稍微不对就报
     `Failed to resolve Python.Runtime.Loader.Initialize`。
     这个报错**重装 WebView2 没用**，所以必须有条不依赖它的退路。

  ② **浏览器应用模式**（Edge / Chrome 的 --app）
     起出来的窗口没有地址栏、没有标签页、没有书签栏，
     看着就是个普通的桌面应用，但**完全不碰 pythonnet**。
     只要机器上有 Edge（Win10/11 一般自带）或者 Chrome 就能用。
     —— 这条就是给上面那种"WebView2 装了却还是起不来"的机器准备的。

  ③ **普通浏览器标签页**
     实在都没辙了才走这条。会额外留一个小窗口守着服务，
     并明确告诉用户"界面在浏览器里"，用完点退出。

也可以强制指定：BiliFav Studio.exe --browser / --app
"""
from __future__ import annotations

import subprocess
import sys
import threading
import traceback
import webbrowser
from pathlib import Path
from typing import Optional

# 保证从任何目录启动都能找到 bilifav 包
if not getattr(sys, "frozen", False):
    sys.path.insert(0, str(Path(__file__).resolve().parent))

# 无控制台运行时 stdout 可能是 None；有控制台时中文 Windows 又是 GBK，
# 两头都得防一下，绝不能因为打印一句话就把程序搞崩。
for _stream in (sys.stdout, sys.stderr):
    try:
        if _stream is not None:
            _stream.reconfigure(errors="replace")
    except (AttributeError, ValueError):
        pass


def show_error(title: str, message: str) -> None:
    """打包成无控制台的 exe 之后，出错只能靠弹窗告诉用户。"""
    try:
        import ctypes

        ctypes.windll.user32.MessageBoxW(0, str(message), str(title), 0x10)
    except Exception:  # noqa: BLE001
        try:
            print(f"{title}\n{message}")
        except Exception:  # noqa: BLE001
            pass


def webview2_ready() -> bool:
    """
    系统里装没装 Edge WebView2 运行时。

    直接问注册表最省事 —— 比"试着开窗口、失败了再兜底"体面得多：
    用户看不到任何报错，程序安安静静换下一条路。

    注意：这个函数**只能说明运行时在**，不代表 pywebview 一定起得来
    （pythonnet 那层的 .NET 版本问题是另一回事），所以它返回 True
    之后仍然要 try。
    """
    try:
        import winreg
    except ImportError:
        return False

    guid = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
    paths = [
        rf"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{guid}",
        rf"SOFTWARE\Microsoft\EdgeUpdate\Clients\{guid}",
    ]
    for hive in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
        for p in paths:
            try:
                with winreg.OpenKey(hive, p) as h:
                    ver, _ = winreg.QueryValueEx(h, "pv")
                    if ver and str(ver).strip() not in ("", "0.0.0.0"):
                        return True
            except OSError:
                continue
    return False


# --------------------------------------------------------------------------
# 找浏览器
# --------------------------------------------------------------------------
def _find_browser() -> Optional[str]:
    """
    找 Edge 或 Chrome 的可执行文件。

    先查注册表的 App Paths —— 那个最可靠，装在非默认目录也能找着。
    再退回到几个常见路径。

    注意：注册表里可能留着已经卸载掉的浏览器（比如 Edge 被删了但键还在），
    所以**每一项都要 Test-Path 确认文件真的在**，光看注册表会被骗。
    """
    import winreg

    names = ("msedge.exe", "chrome.exe")
    keys = [
        r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths",
        r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths",
    ]
    for name in names:
        for base in keys:
            for hive in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
                try:
                    with winreg.OpenKey(hive, rf"{base}\{name}") as h:
                        path = str(winreg.QueryValueEx(h, "")[0]).strip('"')
                        if path and Path(path).is_file():
                            return path
                except OSError:
                    continue

    import os

    guesses = []
    for env in ("ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"):
        root = os.environ.get(env)
        if not root:
            continue
        guesses += [
            Path(root) / "Microsoft" / "Edge" / "Application" / "msedge.exe",
            Path(root) / "Google" / "Chrome" / "Application" / "chrome.exe",
        ]
    for g in guesses:
        if g.is_file():
            return str(g)
    return None


def _app_data_dir() -> str:
    """
    应用模式要用的独立 profile 目录。

    为什么必须给：如果这台机器上已经开着一个 Chrome/Edge，
    不带 --user-data-dir 的话新进程会把请求交给**已有的那个实例**去开标签页，
    --app 就白写了，然后自己退出 —— 结果还是蹦出一个带地址栏的浏览器。
    给个单独的目录，等于起一个干净的独立实例，才会老老实实按 --app 来。
    """
    from bilifav.paths import data_root

    d = data_root() / "browser-profile"
    try:
        d.mkdir(parents=True, exist_ok=True)
    except OSError:
        return ""
    return str(d)


def app_window_mode(url: str) -> bool:
    """
    用浏览器的「应用模式」开一个窗口。成功返回 True。

    起出来的窗口没有地址栏、没有标签页、没有书签栏 —— 看着就是个桌面应用。
    这条路径**不碰 pythonnet / WebView2**，所以上面那个
    `Python.Runtime.Loader.Initialize` 的毛病在它这儿根本不存在。

    阻塞到用户关掉窗口为止（这样服务能跟着一起收摊）。
    """
    exe = _find_browser()
    if not exe:
        return False

    args = [
        f"--app={url}",
        "--window-size=1420,920",
        "--no-first-run",
        "--no-default-browser-check",
        # 关掉"是否设为默认浏览器"之类的打扰
        "--disable-features=Translate,ChromeWhatsNewUI",
    ]
    profile = _app_data_dir()
    if profile:
        args.append(f"--user-data-dir={profile}")

    try:
        # 用 Popen 而不是 os.startfile：需要等它退出，好把服务一起收掉
        proc = subprocess.Popen([exe, *args])
    except OSError as exc:
        try:
            print(f"[app-mode] 起不来：{type(exc).__name__}: {exc}")
        except Exception:  # noqa: BLE001
            pass
        return False

    try:
        proc.wait()
    except KeyboardInterrupt:
        try:
            proc.terminate()
        except Exception:  # noqa: BLE001
            pass
    return True


def icon_path() -> Optional[Path]:
    """
    找那个 .ico。打包后它在 _internal/assets/ 里，源码跑时在 assets/ 里。
    """
    import sys as _sys
    from pathlib import Path as _P

    if getattr(_sys, "frozen", False):
        base = _P(getattr(_sys, "_MEIPASS", _P(_sys.executable).parent))
        cands = [base / "assets" / "icon.ico",
                 _P(_sys.executable).parent / "assets" / "icon.ico",
                 _P(_sys.executable).parent / "_internal" / "assets" / "icon.ico"]
    else:
        cands = [_P(__file__).resolve().parent / "assets" / "icon.ico"]
    for c in cands:
        if c.is_file():
            return c
    return None


def apply_window_icon() -> None:
    """
    把窗口图标换成我们的。

    为什么必须手动设：pywebview 在 Windows 上用 WinForms 起窗口，
    不指定 Icon 就用系统默认的 —— 任务栏上显示成一个"地球"。
    而 exe 的图标（PyInstaller --icon）只管资源管理器里那个文件长得怎么样，
    跟运行时窗口是两码事。

    clr / System.Drawing 都是打包时带上的（pythonnet 那一套），
    真取不到就算了 —— 图标难看点，但不该因此起不来。
    """
    ico = icon_path()
    if not ico:
        return
    try:
        import clr

        clr.AddReference("System.Drawing")
        clr.AddReference("System.Windows.Forms")
        from System.Drawing import Icon
        from System.Windows.Forms import Application

        icon = Icon(str(ico))
        forms = list(Application.OpenForms)
        for form in forms:
            try:
                form.Icon = icon
            except Exception:  # noqa: BLE001
                pass
        try:
            print(f"[icon] 窗口图标换成 {ico.name}（改了 {len(forms)} 个窗口）")
        except Exception:  # noqa: BLE001
            pass
    except Exception as exc:  # noqa: BLE001
        try:
            print(f"[icon] 设图标失败（不影响使用）：{type(exc).__name__}: {exc}")
        except Exception:  # noqa: BLE001
            pass


def browser_mode(url: str, note: str = "") -> None:
    """
    最后的手段：用系统默认浏览器开一个标签页，并留个小窗口守着服务。

    为什么要留窗口：服务跑在后台，用户关掉浏览器标签页后进程还在，
    任务管理器里会莫名其妙多一个。给个明确的"退出"按钮，心里有数。

    tkinter 是 Python 自带的，打包时已经带上了；万一真没有，
    就退化成"静静地跑着，Ctrl+C 结束"。
    """
    try:
        webbrowser.open(url)
    except Exception:  # noqa: BLE001
        pass

    try:
        import tkinter as tk
    except Exception:  # noqa: BLE001
        try:
            threading.Event().wait()
        except KeyboardInterrupt:
            return
        return

    root = tk.Tk()
    root.title("BiliFav Studio 正在运行")
    root.geometry("460x210")
    root.resizable(False, False)
    try:
        root.attributes("-topmost", True)
        root.after(1200, lambda: root.attributes("-topmost", False))
    except Exception:  # noqa: BLE001
        pass

    tk.Label(root, text="界面已经在浏览器里打开了", font=("Microsoft YaHei UI", 13, "bold")).pack(pady=(18, 4))
    if note:
        tk.Label(root, text=note, fg="#5C7A94", font=("Microsoft YaHei UI", 9),
                 wraplength=420, justify="center").pack()

    ent = tk.Entry(root, font=("Consolas", 9), justify="center")
    ent.insert(0, url)
    ent.configure(state="readonly")
    ent.pack(fill="x", padx=24, pady=(10, 12))

    row = tk.Frame(root)
    row.pack()
    tk.Button(row, text="再打开一次", width=12, font=("Microsoft YaHei UI", 10),
              command=lambda: webbrowser.open(url)).pack(side="left", padx=6)
    tk.Button(row, text="退出程序", width=12, font=("Microsoft YaHei UI", 10),
              command=root.destroy).pack(side="left", padx=6)

    tk.Label(root, text="用完点「退出程序」，或者直接关掉这个窗口",
             fg="#8FA6BC", font=("Microsoft YaHei UI", 8)).pack(pady=(14, 0))

    root.mainloop()


def main() -> int:
    from bilifav.paths import data_root
    from bilifav.server import HUB, create_server

    try:
        httpd, url = create_server()
    except Exception as exc:  # noqa: BLE001
        show_error("启动失败", f"本地服务起不来：\n{type(exc).__name__}: {exc}")
        return 1

    # 服务跑在后台线程，主线程留给窗口
    threading.Thread(target=httpd.serve_forever, daemon=True, name="bili-http").start()

    force_browser = "--browser" in sys.argv
    force_app = "--app" in sys.argv

    def finish() -> None:
        try:
            HUB.control("stop")
        except Exception:  # noqa: BLE001
            pass
        try:
            httpd.shutdown()
            httpd.server_close()
        except Exception:  # noqa: BLE001
            pass

    def run_browser(note: str) -> int:
        try:
            browser_mode(url, note)
        finally:
            finish()
        return 0

    # ---- ② 应用模式（用户点名要，或者①走不通时）----
    def run_app(note: str = "") -> Optional[int]:
        if note:
            try:
                print(f"[app-mode] {note}")
            except Exception:  # noqa: BLE001
                pass
        try:
            ok = app_window_mode(url)
        except Exception as exc:  # noqa: BLE001
            try:
                print(f"[app-mode] 出错了：{type(exc).__name__}: {exc}")
            except Exception:  # noqa: BLE001
                pass
            return None
        if not ok:
            return None
        finish()
        return 0

    if force_browser:
        return run_browser("")

    # ---- ① 真原生窗口 ----
    # 没装 WebView2 就不必试了，直接去②
    if force_app or not webview2_ready():
        note = "" if force_app else "这台电脑没装 Edge WebView2 运行时"
        r = run_app(note)
        if r is not None:
            return r
        return run_browser("" if force_app else "这台电脑没装 Edge WebView2 运行时，所以改用浏览器打开。功能完全一样。")

    try:
        import webview
    except ImportError:
        r = run_app("没找到 pywebview 组件")
        if r is not None:
            return r
        return run_browser("没有找到 pywebview 组件，所以改用浏览器打开。功能完全一样。")

    webview.create_window(
        "BiliFav Studio  ·  大肥鱼的收藏夹整理小站",
        url,
        width=1420,
        height=920,
        min_size=(1080, 660),
        background_color="#080c18",
        text_select=True,
    )

    try:
        # func 在后端就绪、窗口已经建好之后回调 —— 正好用来换图标
        webview.start(func=apply_window_icon, debug=False)
    except TypeError:
        # 极老的 pywebview 可能不认 func 这个参数。退回不传，
        # 图标就用系统默认的 —— 难看点，但不能因为一个图标就起不来。
        webview.start(debug=False)
    except Exception as exc:  # noqa: BLE001
        # 探测说"有"、真开的时候还是炸了 —— 最常见的就是 pythonnet 那层
        # 报 Failed to resolve Python.Runtime.Loader.Initialize（.NET 运行时
        # 版本对不上，重装 WebView2 是没用的）。
        # 别弹错误框吓人，直接换应用模式，用户照样有一个像样的窗口用。
        try:
            print(f"[webview] 原生窗口没开起来：{type(exc).__name__}: {exc}")
        except Exception:  # noqa: BLE001
            pass
        r = run_app("原生窗口没开起来")
        if r is not None:
            return r
        return run_browser("原生窗口没开起来，已经改用浏览器打开。功能完全一样。")
    finally:
        finish()

    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        pass
