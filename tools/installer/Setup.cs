// Native Windows installer; built by tools/build_release.py.
// Extract beside the selected destination, without a self-extracting runtime.
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: AssemblyTitle("BiliFav Studio 安装程序")]
[assembly: AssemblyProduct("BiliFav Studio")]
[assembly: AssemblyDescription("BiliFav Studio v1.0.0 安装向导")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]

namespace BiliFavSetup
{
    internal static class Program
    {
        private const string AppName = "BiliFav Studio";
        private const string AppExe = "BiliFav Studio.exe";
        private const string Version = "1.0.0";

        [STAThread]
        private static void Main(string[] args)
        {
            // 静默模式：BiliFav-Studio-安装程序.exe --silent [目标目录]
            bool extractOnly = Array.IndexOf(args, "--extract-only") >= 0;
            if (Array.IndexOf(args, "--silent") >= 0 || extractOnly)
            {
                int i = Array.IndexOf(args, extractOnly ? "--extract-only" : "--silent");
                string dir = (i + 1 < args.Length) ? args[i + 1] : DefaultDir();
                // 日志保存在安装目录，避免依赖系统临时目录的权限。
                StreamWriter w = null;
                try
                {
                    Directory.CreateDirectory(dir);
                    w = new StreamWriter(Path.Combine(dir, "install.log"), false, Encoding.UTF8);
                }
                catch (Exception) { }
                try
                {
                    bool ok = Install(dir, false, false, s => { if (w != null) { w.WriteLine(s); w.Flush(); } }, !extractOnly);
                    Environment.ExitCode = ok ? 0 : 1;
                    if (w != null) w.WriteLine("日志：" + Path.Combine(dir, "install.log"));
                }
                finally { if (w != null) w.Close(); }
                return;
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new SetupForm());
        }

        internal static string DefaultDir()
        {
            string b = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            return Path.Combine(b, AppName);
        }

        /// <summary>把嵌入的 payload.zip 解开、复制到目标目录，再建快捷方式和卸载信息。</summary>
        internal static bool Install(string target, bool desktop, bool launch, Action<string> log, bool integrate = true)
        {
            try
            {
                target = Path.GetFullPath(target);
                log("正在准备安装目录…");
                Directory.CreateDirectory(target);

                // 在目标目录旁解压，避免系统临时目录权限或跨盘复制问题。
                string parent = Path.GetDirectoryName(target);
                if (string.IsNullOrEmpty(parent)) parent = target;
                string tmp = Path.Combine(parent, "bilifav-tmp-" + Guid.NewGuid().ToString("N").Substring(0, 6));
                Directory.CreateDirectory(tmp);

                log("正在解压文件…");
                using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip"))
                {
                    if (s == null) throw new InvalidDataException("安装包资源缺失");
                    string zip = Path.Combine(tmp, "payload.zip");
                    using (var fs = new FileStream(zip, FileMode.Create, FileAccess.Write)) s.CopyTo(fs);
                    ZipFile.ExtractToDirectory(zip, tmp);
                    File.Delete(zip);
                }

                // zip 里可能多套一层目录，找含 exe 的那层
                string root = tmp;
                if (!File.Exists(Path.Combine(root, AppExe)))
                {
                    foreach (string d in Directory.GetDirectories(root))
                    {
                        if (File.Exists(Path.Combine(d, AppExe))) { root = d; break; }
                    }
                }

                log("正在复制到安装目录…");
                string existingExe = Path.Combine(target, AppExe);
                if (File.Exists(existingExe))
                {
                    // Fail before copying if the installed application is still running.
                    using (var probe = new FileStream(existingExe, FileMode.Open, FileAccess.ReadWrite, FileShare.None)) { }
                }
                CopyTree(root, target);
                try { Directory.Delete(tmp, true); } catch (Exception) { }

                if (!integrate) { log("✓ 文件解压验证完成"); return true; }

                string exe = Path.Combine(target, AppExe);
                string icon = Path.Combine(target, "_internal", "assets", "icon.ico");
                if (!File.Exists(icon)) icon = exe;

                log("正在创建开始菜单快捷方式…");
                string startDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                                               @"Microsoft\Windows\Start Menu\Programs");
                Directory.CreateDirectory(startDir);
                string err = Shortcut(Path.Combine(startDir, AppName + ".lnk"), exe, target, icon);
                if (err != null) log("  ⚠ 开始菜单快捷方式没建成：" + err);

                if (desktop)
                {
                    log("正在创建桌面快捷方式…");
                    string desk = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
                    if (Directory.Exists(desk))
                    {
                        err = Shortcut(Path.Combine(desk, AppName + ".lnk"), exe, target, icon);
                        if (err != null) log("  ⚠ 桌面快捷方式没建成：" + err);
                    }
                }

                log("正在登记卸载信息…");
                err = Registry(target, exe, startDir);
                if (err != null) log("  ⚠ 卸载信息没登记上：" + err);

                log("");
                log("✓ 装好了：" + target);
                if (launch)
                {
                    log("正在启动…");
                    Process.Start(new ProcessStartInfo(exe) { WorkingDirectory = target, UseShellExecute = true });
                }
                return true;
            }
            catch (Exception ex)
            {
                log("✗ 出错了：" + ex.Message);
                return false;
            }
        }

        private static void CopyTree(string from, string to)
        {
            Directory.CreateDirectory(to);
            foreach (string f in Directory.GetFiles(from))
            {
                string dst = Path.Combine(to, Path.GetFileName(f));
                File.Copy(f, dst, true);
            }
            foreach (string d in Directory.GetDirectories(from))
                CopyTree(d, Path.Combine(to, Path.GetFileName(d)));
        }

        /// <summary>把异常链摊平 —— TargetInvocationException 外面那层什么都没说，真因在 InnerException。</summary>
        private static string Why(Exception ex)
        {
            var sb = new StringBuilder();
            Exception e = ex;
            while (e != null)
            {
                if (sb.Length > 0) sb.Append(" ← ");
                sb.Append(e.GetType().Name).Append(": ").Append(e.Message);
                e = e.InnerException;
            }
            return sb.ToString();
        }

        /// <summary>建快捷方式。成功返回 null，失败返回原因（别吞掉——之前吞了，结果快捷方式没建出来还不吭声）。</summary>
        private static string Shortcut(string lnk, string target, string workdir, string icon)
        {
            object shell = null, sc = null;
            try
            {
                Type t = Type.GetTypeFromProgID("WScript.Shell");
                if (t == null) return "拿不到 WScript.Shell（COM 不可用）";
                shell = Activator.CreateInstance(t);
                sc = t.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell,
                                    new object[] { lnk });
                if (sc == null) return "CreateShortcut 返回空";
                Type st = sc.GetType();
                st.InvokeMember("TargetPath", BindingFlags.SetProperty, null, sc, new object[] { target });
                st.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, sc, new object[] { workdir });
                st.InvokeMember("IconLocation", BindingFlags.SetProperty, null, sc, new object[] { icon });
                st.InvokeMember("Description", BindingFlags.SetProperty, null, sc, new object[] { "慢慢搬，不着急" });
                st.InvokeMember("Save", BindingFlags.InvokeMethod, null, sc, null);
                return File.Exists(lnk) ? null : "Sava 之后文件还是不存在";
            }
            catch (Exception ex)
            {
                return Why(ex);
            }
            finally
            {
                if (sc != null) try { System.Runtime.InteropServices.Marshal.ReleaseComObject(sc); } catch (Exception) { }
                if (shell != null) try { System.Runtime.InteropServices.Marshal.ReleaseComObject(shell); } catch (Exception) { }
            }
        }

        private static string Registry(string target, string exe, string startDir)
        {
            try
            {
                string key = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\" + AppName;
                using (RegistryKey k = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(key))
                {
                    if (k == null) return "CreateSubKey 返回空";
                    k.SetValue("DisplayName", AppName);
                    k.SetValue("DisplayVersion", Version);
                    k.SetValue("Publisher", AppName);
                    k.SetValue("InstallLocation", target);
                    k.SetValue("DisplayIcon", exe);
                    k.SetValue("NoModify", 1, RegistryValueKind.DWord);
                    k.SetValue("NoRepair", 1, RegistryValueKind.DWord);
                    k.SetValue("UninstallString", UninstallCommand(target, startDir, key));
                }
                return null;
            }
            catch (Exception ex)
            {
                return Why(ex);
            }
        }

        internal static string UninstallCommand(string target, string startDir, string key)
        {
            // Remove only known program paths; preserve data and other user files.
            string ps = "$ErrorActionPreference='Stop'; $root=[IO.Path]::GetFullPath(" + Quote(target) + "); "
                + "$app=Join-Path $root 'BiliFav Studio.exe'; "
                + "if (!(Test-Path -LiteralPath $app -PathType Leaf)) { throw '找不到程序，已停止卸载' }; "
                + "foreach ($name in @('_internal','BiliFav Studio.exe','使用教程.md','使用说明.txt')) { "
                + "$path=[IO.Path]::GetFullPath((Join-Path $root $name)); "
                + "if ([IO.Path]::GetDirectoryName($path) -ne $root) { throw '目录不匹配' }; "
                + "if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force } }; "
                + "$shell=New-Object -ComObject WScript.Shell; foreach ($link in @(" 
                + Quote(Path.Combine(startDir, AppName + ".lnk")) + ","
                + Quote(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), AppName + ".lnk")) + ")) { "
                + "if ((Test-Path -LiteralPath $link) -and $shell.CreateShortcut($link).TargetPath -eq $app) { Remove-Item -LiteralPath $link -Force } }; "
                + "$key=" + Quote(@"HKCU:\" + key) + "; "
                + "if ((Get-ItemProperty -LiteralPath $key -ErrorAction SilentlyContinue).InstallLocation -eq $root) { Remove-Item -LiteralPath $key -Recurse -Force }";
            return "powershell.exe -NoProfile -WindowStyle Hidden -Command \"" + ps + "\"";
        }

        private static string Quote(string text) { return "'" + text.Replace("'", "''") + "'"; }
    }

    internal sealed class SetupForm : Form
    {
        private readonly TextBox _dir = new TextBox();
        private readonly CheckBox _desk = new CheckBox();
        private readonly CheckBox _launch = new CheckBox();
        private readonly TextBox _log = new TextBox();
        private readonly Button _go = new Button();
        private bool _finished, _installing;

        internal SetupForm()
        {
            Text = "BiliFav Studio 安装向导";
            ClientSize = new Size(580, 430);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            Font = new Font("Microsoft YaHei UI", 9F);
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch (Exception) { }

            var title = new Label
            {
                Text = "BiliFav Studio",
                Font = new Font("Microsoft YaHei UI", 17F, FontStyle.Bold),
                ForeColor = Color.FromArgb(13, 32, 51),
                AutoSize = true,
                Location = new Point(24, 20),
            };
            Controls.Add(title);

            Controls.Add(new Label
            {
                Text = "慢慢搬，不着急",
                ForeColor = Color.FromArgb(92, 122, 148),
                AutoSize = true,
                Location = new Point(27, 56),
            });

            Controls.Add(new Label { Text = "安装到：", AutoSize = true, Location = new Point(27, 96) });

            _dir.Text = Program.DefaultDir();
            _dir.Location = new Point(27, 118);
            _dir.Size = new Size(430, 26);
            Controls.Add(_dir);

            var browse = new Button { Text = "浏览…", Location = new Point(464, 117), Size = new Size(88, 28) };
            browse.Click += (s, e) =>
            {
                using (var d = new FolderBrowserDialog { SelectedPath = _dir.Text })
                    if (d.ShowDialog() == DialogResult.OK) _dir.Text = d.SelectedPath;
            };
            Controls.Add(browse);

            _desk.Text = "创建桌面快捷方式";
            _desk.Checked = true;
            _desk.AutoSize = true;
            _desk.Location = new Point(27, 158);
            Controls.Add(_desk);

            _launch.Text = "安装完成后直接启动";
            _launch.Checked = true;
            _launch.AutoSize = true;
            _launch.Location = new Point(27, 182);
            Controls.Add(_launch);

            _log.Multiline = true;
            _log.ReadOnly = true;
            _log.ScrollBars = ScrollBars.Vertical;
            _log.BackColor = Color.FromArgb(242, 245, 249);
            _log.ForeColor = Color.FromArgb(13, 32, 51);
            _log.Location = new Point(27, 214);
            _log.Size = new Size(525, 160);
            Controls.Add(_log);

            _go.Text = "开始安装";
            _go.Size = new Size(110, 32);
            _go.Location = new Point(442, 386);
            _go.Click += (s, e) => StartInstall();
            Controls.Add(_go);

            var cancel = new Button { Text = "取消", Size = new Size(90, 32), Location = new Point(344, 386) };
            cancel.Click += (s, e) => Close();
            Controls.Add(cancel);

            Controls.Add(new Label
            {
                Text = "1.0.0 · 数据保存在安装目录的 data 文件夹",
                ForeColor = Color.FromArgb(143, 166, 188),
                AutoSize = true,
                Location = new Point(27, 392),
            });
        }

        private void StartInstall()
        {
            if (_finished) { Close(); return; }
            if (_installing) return;
            _installing = true;
            _go.Enabled = false;
            _go.Text = "安装中…";
            string dir = _dir.Text.Trim();
            bool desk = _desk.Checked, launch = _launch.Checked;

            new Thread(() =>
            {
                bool ok = Program.Install(dir, desk, launch, s => BeginInvoke((Action)(() =>
                {
                    _log.AppendText(s + Environment.NewLine);
                })));
                BeginInvoke((Action)(() =>
                {
                    _installing = false;
                    _finished = ok;
                    _go.Text = ok ? "完成" : "重试";
                    _go.Enabled = true;
                }));
            }) { IsBackground = true }.Start();
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (_installing) e.Cancel = true;
            base.OnFormClosing(e);
        }
    }
}
