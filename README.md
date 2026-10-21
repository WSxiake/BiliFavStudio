# 🐳 BiliFav Studio

> [!IMPORTANT]
> **本软件的所有内容，包括本仓库的上传与发布，均由 AI 完成。作者仅负责许愿、监工和测试。**
>
> 遇到 Bug，可以到[侠客的 B 站空间](https://space.bilibili.com/391987/)私信反馈，或在本仓库提交 [**Issues**](https://github.com/WSxiake/BiliFavStudio/issues)。看到了会想办法鞭策 AI 改好，继续迭代。

大肥鱼的收藏夹整理小站：在电脑上浏览、整理和搬运 B 站收藏夹。

## 功能

- **浏览**：按标题、UP 主、收藏日期和自建标签筛选，查看页内及选中视频的总时长。
- **整理**：拖动插入或交换、多选、复制/剪切/粘贴、排序、标记增删，确认后提交到 B 站。
- **本地保存**：自动草稿、Ctrl+S、撤销/重做和操作历史；「保存整理」先存到本机，线上修改通过「提交改动」执行。
- **搬运**：将公开收藏夹的视频收藏到自己的收藏夹，支持进度保存、暂停和恢复。
- **个性化**：主题色、Windows 主题色跟随、白天/夜晚、自定义快捷键和可调宽的左右侧栏。
- **教程**：板块旁的问号提供分步说明和对应控件高亮。

已有完整缓存的收藏夹可以直接打开，提交前核对线上基线。大量搜索结果和平铺列表按可见区域显示，完整选择与导出仍覆盖全部匹配视频。

## 使用

下载发布页提供的安装包，或完整解压免安装 ZIP 后运行 **BiliFav Studio.exe**。不要只复制 exe，旁边的 `_internal` 文件夹也需要保留。

首次使用打开软件后扫码登录。详细流程见 [使用教程](docs/使用教程.md)。

更新前退出程序，保留原来的 **data** 文件夹。软件的登录信息、设置、缓存、草稿和任务记录都保存在本机；不要把 data 文件夹上传到 GitHub 或反馈附件。

## 从源码运行

本机已验证 Windows + Python 3.12：

```powershell
python -m pip install -r requirements.txt
python app.py
```

网页模式：`python run.py --no-browser`，再打开控制台给出的本机地址。

## 检查与构建

源码仓库保留自动检查和打包工具。检查使用假账号及本机模拟响应，不操作真实 B 站账号：

```powershell
python selftest.py
python -m unittest discover -s tests -p "test_*.py"
npm install --ignore-scripts
npx playwright install chromium
npm test
```

浏览器检查需要 Node.js；可通过 `BROWSER_EXECUTABLE` 指定已安装浏览器。GitHub 自动检查位于 `.github/workflows/check.yml`。

在 Windows 上生成桌面程序、安装包和免安装 ZIP：

```powershell
python -m pip install -r requirements-dev.txt
powershell -ExecutionPolicy Bypass -File tools/build_windows.ps1
```

桌面程序输出到 `dist_new/build-编号/BiliFav Studio/`，每次构建使用新目录；发布包输出到 `release/v1.0.0/`。安装包使用 Windows 自带的 .NET Framework 编译器构建。运行数据与检查输出不参与打包。

## 版本与发布

当前版本为 **v1.0.0（首次公开发布）**。发布页提供 Windows 安装包及免安装 ZIP；仓库保留程序源码、教程、检查和构建工具。

[版本说明](CHANGELOG.md)
