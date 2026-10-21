# -*- coding: utf-8 -*-
"""
BiliFav Studio —— B 站收藏夹搬运与整理工具。

模块分工：
    api      B 站 Web 接口客户端（限速、重试、风控熔断）
    engine   复制引擎（建索引 → 逐条搬运，支持断点续传）
    sorter   顺序整理引擎（拖拽重排 / 智能排序 → 增量操作序列 → 提交）
    pinyin   内置拼音表，供中文按拼音排序
    state    断点续传状态持久化
    session  登录态本地持久化
    server   本地 HTTP 服务（给界面提供 REST 接口）
    paths    目录解析（便携模式优先）
    util     零散工具（ID 解析、错误归类、排序键）

设计原则：
    * 只读公开可见的收藏夹内容；
    * 只写入调用者自己账号下的收藏夹；
    * 全程本地运行，Cookie 只发往 bilibili.com；
    * 所有写操作都带限速与风控熔断，宁慢勿封。
"""

__version__ = "1.0.0"
__all__ = ["__version__"]
