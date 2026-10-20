// iebox-host - a tiny WinForms window that hosts the real MSHTML/Trident engine.
//
// This file is compiled on the user's machine by the built-in .NET Framework 4
// compiler (csc.exe). There is no SDK, NuGet package or MSBuild step involved.
//
// Design rules:
//   * ASCII-only source. Any typographic character is written as a \uXXXX escape
//     so that csc reads the file correctly with any ANSI code page.
//   * C# 5 syntax only (csc 4.0.30319). No string interpolation, no ?. , no nameof.
//   * Every COM call is wrapped in try/catch. A hostile page must never take the
//     window down.
//   * Writes only to %LOCALAPPDATA%\iebox\config.json and HKCU.
//
// Compile:
//   csc.exe /nologo /target:winexe /out:iebox-host.exe
//           /r:System.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll
//           IeBoxHost.cs

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;
using System.Windows.Forms;
using Microsoft.Win32;

namespace IeBox
{
    // ---------------------------------------------------------------------
    // Entry point
    // ---------------------------------------------------------------------
    internal static class Program
    {
        private const string ProductName = "iebox";
        private const string DefaultHome = "https://example.com/";

        [DllImport("user32.dll")]
        private static extern bool SetProcessDPIAware();

        [STAThread]
        private static int Main(string[] args)
        {
            try { SetProcessDPIAware(); } catch { }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            Application.ThreadException += delegate(object sender, System.Threading.ThreadExceptionEventArgs e)
            {
                ShowFatal("Unexpected error", e.Exception);
            };
            AppDomain.CurrentDomain.UnhandledException += delegate(object sender, UnhandledExceptionEventArgs e)
            {
                ShowFatal("Unexpected error", e.ExceptionObject as Exception);
            };

            try
            {
                return Run(args);
            }
            catch (Exception ex)
            {
                ShowFatal("iebox could not start", ex);
                return 1;
            }
        }

        private static void ShowFatal(string title, Exception ex)
        {
            try
            {
                string message = title;
                if (ex != null) message += "\r\n\r\n" + ex.Message;
                MessageBox.Show(message, "iebox", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            catch { }
        }

        private static int Run(string[] args)
        {
            string url = null;
            string emulationOverride = null;
            string selftestPath = null;
            bool home = false;

            for (int i = 0; i < args.Length; i++)
            {
                string a = args[i];
                if (a == "--home") { home = true; continue; }
                if (a == "--emulation" && i + 1 < args.Length) { emulationOverride = args[++i]; continue; }
                if (a.StartsWith("--emulation=", StringComparison.OrdinalIgnoreCase))
                {
                    emulationOverride = a.Substring("--emulation=".Length);
                    continue;
                }
                if (a == "--selftest" && i + 1 < args.Length) { selftestPath = args[++i]; continue; }
                if (a.StartsWith("--", StringComparison.Ordinal)) continue;
                if (url == null) url = a;
            }

            Config config = Config.Load();

            string exeName = "iebox-host.exe";
            try
            {
                string file = Path.GetFileName(Application.ExecutablePath);
                if (!string.IsNullOrEmpty(file)) exeName = file;
            }
            catch { }

            string emulation = emulationOverride;
            if (string.IsNullOrEmpty(emulation) || !Emulation.IsKnown(emulation)) emulation = config.Emulation;
            if (!Emulation.IsKnown(emulation)) emulation = Emulation.Default;

            // This MUST happen before the WebBrowser control is created. The
            // control reads FEATURE_BROWSER_EMULATION when it instantiates the
            // MSHTML document object; without it, IE7 quirks mode is used.
            Emulation.Apply(exeName, Emulation.Value(emulation));

            if (string.IsNullOrEmpty(url))
            {
                url = home ? config.HomeUrl : (string.IsNullOrEmpty(config.LastUrl) ? config.HomeUrl : config.LastUrl);
            }
            if (string.IsNullOrEmpty(url)) url = DefaultHome;

            if (string.IsNullOrEmpty(selftestPath) && !config.SeenWarning)
            {
                using (WarningForm warning = new WarningForm())
                {
                    DialogResult result = warning.ShowDialog();
                    if (result != DialogResult.OK) return 0;
                    if (warning.DontShowAgain)
                    {
                        config.SeenWarning = true;
                        config.Save();
                    }
                }
            }

            if (!string.IsNullOrEmpty(selftestPath))
            {
                return SelfTest(config, url, exeName, selftestPath);
            }

            using (MainForm form = new MainForm(config, url, exeName))
            {
                Application.Run(form);
            }
            return 0;
        }

        // Creates the real window and browser control, closes it automatically,
        // and writes a small JSON result. Useful for smoke-testing the engine on
        // a machine (or CI runner) without a human in front of the screen.
        private static int SelfTest(Config config, string url, string exeName, string outputPath)
        {
            string result;
            try
            {
                using (MainForm form = new MainForm(config, url, exeName))
                {
                    System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
                    timer.Interval = 2500;
                    timer.Tick += delegate(object sender, EventArgs e)
                    {
                        timer.Stop();
                        try { form.Close(); } catch { }
                    };
                    form.Shown += delegate
                    {
                        timer.Start();
                    };
                    Application.Run(form);
                }
                result = "{\"ok\":true,\"message\":\"host window and WebBrowser control created\"}";
                WriteAllTextSafe(outputPath, result);
                return 0;
            }
            catch (Exception ex)
            {
                result = "{\"ok\":false,\"error\":" + JsonLite.Quote(ex.Message) + "}";
                WriteAllTextSafe(outputPath, result);
                return 1;
            }
        }

        private static void WriteAllTextSafe(string path, string text)
        {
            try
            {
                string dir = Path.GetDirectoryName(path);
                if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
                File.WriteAllText(path, text, new UTF8Encoding(false));
            }
            catch { }
        }
    }

    // ---------------------------------------------------------------------
    // Emulation modes. Keep in sync with src/emulation.js.
    // ---------------------------------------------------------------------
    internal static class Emulation
    {
        public const string Default = "ie11";

        private static readonly string[] Names = { "ie11", "ie10", "ie9", "ie8", "ie7" };
        private static readonly int[] Values = { 11001, 10001, 9999, 8888, 7000 };
        private static readonly string[] Labels = { "IE11", "IE10", "IE9", "IE8", "IE7" };

        public static bool IsKnown(string name)
        {
            return IndexOf(name) >= 0;
        }

        public static int IndexOf(string name)
        {
            if (name == null) return -1;
            for (int i = 0; i < Names.Length; i++)
            {
                if (string.Equals(Names[i], name.Trim(), StringComparison.OrdinalIgnoreCase)) return i;
            }
            return -1;
        }

        public static int Value(string name)
        {
            int index = IndexOf(name);
            return index < 0 ? Values[0] : Values[index];
        }

        public static string NameAt(int index)
        {
            if (index < 0 || index >= Names.Length) return Default;
            return Names[index];
        }

        public static string LabelAt(int index)
        {
            if (index < 0 || index >= Labels.Length) return Labels[0];
            return Labels[index];
        }

        public static string Label(string name)
        {
            int index = IndexOf(name);
            return index < 0 ? Labels[0] : Labels[index];
        }

        public static int Count
        {
            get { return Names.Length; }
        }

        // Writes HKCU\...\FEATURE_BROWSER_EMULATION\<exeName> = value.
        // Returns false instead of throwing on locked-down machines.
        public static bool Apply(string exeName, int value)
        {
            if (string.IsNullOrEmpty(exeName)) return false;
            try
            {
                using (RegistryKey key = Registry.CurrentUser.CreateSubKey(
                    @"Software\Microsoft\Internet Explorer\Main\FeatureControl\FEATURE_BROWSER_EMULATION"))
                {
                    if (key == null) return false;
                    key.SetValue(exeName, value, RegistryValueKind.DWord);
                    return true;
                }
            }
            catch
            {
                return false;
            }
        }
    }

    // ---------------------------------------------------------------------
    // Minimal, defensive JSON object reader/writer.
    // Only flat objects are produced; unknown nested values are skipped.
    // ---------------------------------------------------------------------
    internal static class JsonLite
    {
        public static Dictionary<string, object> ParseObject(string text)
        {
            Dictionary<string, object> map = new Dictionary<string, object>(StringComparer.OrdinalIgnoreCase);
            if (string.IsNullOrEmpty(text)) return map;
            int i = 0;
            SkipWs(text, ref i);
            if (i >= text.Length || text[i] != '{') throw new FormatException("Expected a JSON object.");
            i++;
            while (true)
            {
                SkipWs(text, ref i);
                if (i >= text.Length) throw new FormatException("Unexpected end of JSON.");
                if (text[i] == '}') { i++; break; }
                if (text[i] != '"') throw new FormatException("Expected a property name.");
                string name = ParseString(text, ref i);
                SkipWs(text, ref i);
                if (i >= text.Length || text[i] != ':') throw new FormatException("Expected ':'.");
                i++;
                object value = ParseValue(text, ref i);
                map[name] = value;
                SkipWs(text, ref i);
                if (i < text.Length && text[i] == ',') { i++; continue; }
                if (i < text.Length && text[i] == '}') { i++; break; }
                throw new FormatException("Expected ',' or '}'.");
            }
            return map;
        }

        private static object ParseValue(string s, ref int i)
        {
            SkipWs(s, ref i);
            if (i >= s.Length) throw new FormatException("Unexpected end of JSON.");
            char c = s[i];
            if (c == '"') return ParseString(s, ref i);
            if (c == '{') { SkipContainer(s, ref i, '{', '}'); return null; }
            if (c == '[') { SkipContainer(s, ref i, '[', ']'); return null; }
            if (c == 't') { Expect(s, ref i, "true"); return true; }
            if (c == 'f') { Expect(s, ref i, "false"); return false; }
            if (c == 'n') { Expect(s, ref i, "null"); return null; }
            return ParseNumber(s, ref i);
        }

        private static void SkipContainer(string s, ref int i, char open, char close)
        {
            int depth = 0;
            while (i < s.Length)
            {
                char c = s[i];
                if (c == '"') { ParseString(s, ref i); continue; }
                if (c == open) depth++;
                else if (c == close)
                {
                    depth--;
                    if (depth == 0) { i++; return; }
                }
                i++;
            }
            throw new FormatException("Unterminated JSON container.");
        }

        private static string ParseString(string s, ref int i)
        {
            if (i >= s.Length || s[i] != '"') throw new FormatException("Expected a string.");
            i++;
            StringBuilder sb = new StringBuilder();
            while (i < s.Length)
            {
                char c = s[i++];
                if (c == '"') return sb.ToString();
                if (c == '\\')
                {
                    if (i >= s.Length) break;
                    char e = s[i++];
                    switch (e)
                    {
                        case '"': sb.Append('"'); break;
                        case '\\': sb.Append('\\'); break;
                        case '/': sb.Append('/'); break;
                        case 'b': sb.Append('\b'); break;
                        case 'f': sb.Append('\f'); break;
                        case 'n': sb.Append('\n'); break;
                        case 'r': sb.Append('\r'); break;
                        case 't': sb.Append('\t'); break;
                        case 'u':
                            if (i + 4 <= s.Length)
                            {
                                int code;
                                if (int.TryParse(s.Substring(i, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out code))
                                {
                                    sb.Append((char)code);
                                    i += 4;
                                    break;
                                }
                            }
                            sb.Append('?');
                            break;
                        default: sb.Append(e); break;
                    }
                }
                else
                {
                    sb.Append(c);
                }
            }
            throw new FormatException("Unterminated JSON string.");
        }

        private static double ParseNumber(string s, ref int i)
        {
            int start = i;
            while (i < s.Length)
            {
                char c = s[i];
                if ((c >= '0' && c <= '9') || c == '-' || c == '+' || c == '.' || c == 'e' || c == 'E') i++;
                else break;
            }
            if (start == i) throw new FormatException("Invalid JSON value.");
            double value;
            if (!double.TryParse(s.Substring(start, i - start), NumberStyles.Float, CultureInfo.InvariantCulture, out value))
                throw new FormatException("Invalid JSON number.");
            return value;
        }

        private static void Expect(string s, ref int i, string token)
        {
            if (i + token.Length > s.Length || string.CompareOrdinal(s, i, token, 0, token.Length) != 0)
                throw new FormatException("Invalid JSON token.");
            i += token.Length;
        }

        private static void SkipWs(string s, ref int i)
        {
            while (i < s.Length && (s[i] == ' ' || s[i] == '\t' || s[i] == '\r' || s[i] == '\n')) i++;
        }

        public static string GetString(Dictionary<string, object> map, string key, string fallback)
        {
            object value;
            if (map != null && map.TryGetValue(key, out value) && value is string) return (string)value;
            return fallback;
        }

        public static bool GetBool(Dictionary<string, object> map, string key, bool fallback)
        {
            object value;
            if (map != null && map.TryGetValue(key, out value) && value is bool) return (bool)value;
            return fallback;
        }

        public static int GetInt(Dictionary<string, object> map, string key, int fallback)
        {
            object value;
            if (map != null && map.TryGetValue(key, out value))
            {
                if (value is double)
                {
                    double d = (double)value;
                    if (d >= int.MinValue && d <= int.MaxValue) return (int)d;
                }
                if (value is string)
                {
                    int parsed;
                    if (int.TryParse((string)value, NumberStyles.Integer, CultureInfo.InvariantCulture, out parsed)) return parsed;
                }
            }
            return fallback;
        }

        public static string Quote(string value)
        {
            if (value == null) return "null";
            StringBuilder sb = new StringBuilder();
            sb.Append('"');
            foreach (char c in value)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\b': sb.Append("\\b"); break;
                    case '\f': sb.Append("\\f"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 32) sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                        else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
            return sb.ToString();
        }
    }

    // ---------------------------------------------------------------------
    // Configuration, kept flat so both Node and C# can read it without a
    // JSON library. Unknown keys are ignored (and preserved by Node).
    // ---------------------------------------------------------------------
    internal sealed class Config
    {
        public string HomeUrl = "https://example.com/";
        public string LastUrl = "";
        public string Emulation = "ie11";
        public bool SeenWarning = false;
        public int Zoom = 100;
        public int WindowX = -1;
        public int WindowY = -1;
        public int WindowWidth = 1200;
        public int WindowHeight = 800;
        public bool WindowMaximized = false;

        public static string DirectoryPath
        {
            get
            {
                // Prefer the environment variable so the host and the Node CLI
                // always agree, even when LOCALAPPDATA is redirected (portable
                // installs, tests, locked-down profiles).
                string local = Environment.GetEnvironmentVariable("LOCALAPPDATA");
                if (string.IsNullOrEmpty(local))
                    local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                if (string.IsNullOrEmpty(local))
                    local = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "AppData", "Local");
                return Path.Combine(local, "iebox");
            }
        }

        public static string FilePath
        {
            get { return Path.Combine(DirectoryPath, "config.json"); }
        }

        public static Config Load()
        {
            Config config = new Config();
            try
            {
                string path = FilePath;
                if (!File.Exists(path)) return config;
                string text = File.ReadAllText(path, Encoding.UTF8);
                Dictionary<string, object> map = JsonLite.ParseObject(text);

                config.HomeUrl = JsonLite.GetString(map, "homeUrl", config.HomeUrl);
                config.LastUrl = JsonLite.GetString(map, "lastUrl", config.LastUrl);
                config.Emulation = JsonLite.GetString(map, "emulation", config.Emulation);
                config.SeenWarning = JsonLite.GetBool(map, "seenWarning", config.SeenWarning);
                config.Zoom = JsonLite.GetInt(map, "zoom", config.Zoom);
                config.WindowX = JsonLite.GetInt(map, "windowX", config.WindowX);
                config.WindowY = JsonLite.GetInt(map, "windowY", config.WindowY);
                config.WindowWidth = JsonLite.GetInt(map, "windowWidth", config.WindowWidth);
                config.WindowHeight = JsonLite.GetInt(map, "windowHeight", config.WindowHeight);
                config.WindowMaximized = JsonLite.GetBool(map, "windowMaximized", config.WindowMaximized);

                if (!IeBox.Emulation.IsKnown(config.Emulation)) config.Emulation = IeBox.Emulation.Default;
                if (config.Zoom < 25 || config.Zoom > 400) config.Zoom = 100;
                if (config.WindowWidth < 480 || config.WindowWidth > 10000) config.WindowWidth = 1200;
                if (config.WindowHeight < 320 || config.WindowHeight > 10000) config.WindowHeight = 800;
            }
            catch
            {
                // Malformed or unreadable config: fall back to defaults. Never
                // let a broken JSON file stop the browser from opening.
                return new Config();
            }
            return config;
        }

        public bool Save()
        {
            try
            {
                Directory.CreateDirectory(DirectoryPath);
                StringBuilder sb = new StringBuilder();
                sb.Append("{\r\n");
                sb.Append("  \"homeUrl\": ").Append(JsonLite.Quote(HomeUrl)).Append(",\r\n");
                sb.Append("  \"lastUrl\": ").Append(JsonLite.Quote(LastUrl)).Append(",\r\n");
                sb.Append("  \"emulation\": ").Append(JsonLite.Quote(Emulation)).Append(",\r\n");
                sb.Append("  \"seenWarning\": ").Append(SeenWarning ? "true" : "false").Append(",\r\n");
                sb.Append("  \"zoom\": ").Append(Zoom.ToString(CultureInfo.InvariantCulture)).Append(",\r\n");
                sb.Append("  \"windowX\": ").Append(WindowX.ToString(CultureInfo.InvariantCulture)).Append(",\r\n");
                sb.Append("  \"windowY\": ").Append(WindowY.ToString(CultureInfo.InvariantCulture)).Append(",\r\n");
                sb.Append("  \"windowWidth\": ").Append(WindowWidth.ToString(CultureInfo.InvariantCulture)).Append(",\r\n");
                sb.Append("  \"windowHeight\": ").Append(WindowHeight.ToString(CultureInfo.InvariantCulture)).Append(",\r\n");
                sb.Append("  \"windowMaximized\": ").Append(WindowMaximized ? "true" : "false").Append("\r\n");
                sb.Append("}\r\n");

                string tmp = FilePath + ".tmp";
                File.WriteAllText(tmp, sb.ToString(), new UTF8Encoding(false));
                if (File.Exists(FilePath)) File.Delete(FilePath);
                File.Move(tmp, FilePath);
                return true;
            }
            catch
            {
                return false;
            }
        }
    }

    // ---------------------------------------------------------------------
    // URL helper for text typed into the address bar.
    // ---------------------------------------------------------------------
    internal static class UrlInput
    {
        public static string Normalize(string input, string fallback)
        {
            string value = (input ?? string.Empty).Trim().Trim('"');
            if (value.Length == 0) return fallback;
            if (value.StartsWith("//", StringComparison.Ordinal)) return "http:" + value;

            // Windows path (C:\foo or \\server\share).
            if (IsWindowsPath(value))
            {
                try { return new Uri(value).AbsoluteUri; }
                catch { return "file:///" + value.Replace('\\', '/'); }
            }

            int colon = value.IndexOf(':');
            if (colon > 0 && colon < 12)
            {
                string scheme = value.Substring(0, colon);
                if (IsScheme(scheme)) return value;
            }

            return "http://" + value;
        }

        private static bool IsWindowsPath(string value)
        {
            if (value.Length >= 3 && char.IsLetter(value[0]) && value[1] == ':' &&
                (value[2] == '\\' || value[2] == '/')) return true;
            return value.StartsWith("\\\\", StringComparison.Ordinal);
        }

        private static bool IsScheme(string scheme)
        {
            if (scheme.Length == 0) return false;
            if (!char.IsLetter(scheme[0])) return false;
            for (int i = 1; i < scheme.Length; i++)
            {
                char c = scheme[i];
                if (!char.IsLetterOrDigit(c) && c != '+' && c != '-' && c != '.') return false;
            }
            return true;
        }
    }

    // ---------------------------------------------------------------------
    // First-run security warning. A plain MessageBox cannot host a checkbox,
    // so this is a small purpose-built modal dialog.
    // ---------------------------------------------------------------------
    internal sealed class WarningForm : Form
    {
        private readonly CheckBox _dontShow;

        public bool DontShowAgain
        {
            get { return _dontShow.Checked; }
        }

        public WarningForm()
        {
            Text = "iebox - security warning";
            FormBorderStyle = FormBorderStyle.FixedDialog;
            StartPosition = FormStartPosition.CenterScreen;
            MaximizeBox = false;
            MinimizeBox = false;
            ShowInTaskbar = true;
            ClientSize = new Size(600, 360);
            BackColor = Color.FromArgb(24, 24, 33);
            ForeColor = Color.FromArgb(232, 233, 242);
            Font = new Font("Segoe UI", 9f);
            try { Icon = SystemIcons.Warning; } catch { }

            Label title = new Label();
            title.Text = "You are about to use a retired engine";
            title.Font = new Font("Segoe UI Semibold", 15f, FontStyle.Bold);
            title.ForeColor = Color.White;
            title.AutoSize = true;
            title.Location = new Point(26, 24);
            Controls.Add(title);

            Label body = new Label();
            body.Text =
                "The legacy Trident engine is unsandboxed and no longer receives security updates. " +
                "Use iebox only for trusted legacy sites. Continue?";
            body.Font = new Font("Segoe UI", 10f);
            body.ForeColor = Color.FromArgb(210, 212, 226);
            body.Location = new Point(28, 76);
            body.Size = new Size(540, 120);
            Controls.Add(body);

            Label note = new Label();
            note.Text =
                "iebox is not a secure browser. It does not isolate tabs, it can run ActiveX controls, " +
                "and it renders pages with the same engine Internet Explorer used in 2013.";
            note.Font = new Font("Segoe UI", 8.5f);
            note.ForeColor = Color.FromArgb(150, 153, 172);
            note.Location = new Point(28, 196);
            note.Size = new Size(540, 60);
            Controls.Add(note);

            _dontShow = new CheckBox();
            _dontShow.Text = "Don't show this warning again";
            _dontShow.ForeColor = Color.FromArgb(210, 212, 226);
            _dontShow.AutoSize = true;
            _dontShow.Location = new Point(28, 262);
            Controls.Add(_dontShow);

            Button cancel = new Button();
            cancel.Text = "Cancel";
            cancel.DialogResult = DialogResult.Cancel;
            cancel.Size = new Size(96, 32);
            cancel.Location = new Point(366, 302);
            cancel.FlatStyle = FlatStyle.Flat;
            cancel.BackColor = Color.FromArgb(40, 40, 54);
            cancel.ForeColor = Color.White;
            cancel.FlatAppearance.BorderColor = Color.FromArgb(70, 70, 92);
            Controls.Add(cancel);

            Button ok = new Button();
            ok.Text = "Continue";
            ok.DialogResult = DialogResult.OK;
            ok.Size = new Size(112, 32);
            ok.Location = new Point(470, 302);
            ok.FlatStyle = FlatStyle.Flat;
            ok.BackColor = Color.FromArgb(124, 58, 237);
            ok.ForeColor = Color.White;
            ok.FlatAppearance.BorderSize = 0;
            Controls.Add(ok);

            AcceptButton = ok;
            CancelButton = cancel;
        }
    }

    // ---------------------------------------------------------------------
    // Small drawn icons for the toolbar (no external image assets).
    // ---------------------------------------------------------------------
    internal enum GlyphKind
    {
        Back,
        Forward,
        Reload,
        Stop,
        Home
    }

    internal sealed class GlyphButton : ToolStripButton
    {
        public GlyphKind Kind = GlyphKind.Back;

        public GlyphButton()
        {
            AutoSize = false;
            Size = new Size(32, 28);
            DisplayStyle = ToolStripItemDisplayStyle.None;
            Margin = new Padding(2, 0, 2, 0);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            Color color = Enabled ? Color.FromArgb(228, 230, 242) : Color.FromArgb(110, 112, 128);
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            float cx = Width / 2f;
            float cy = Height / 2f;

            using (Pen pen = new Pen(color, 1.8f))
            {
                pen.StartCap = LineCap.Round;
                pen.EndCap = LineCap.Round;
                pen.LineJoin = LineJoin.Round;

                switch (Kind)
                {
                    case GlyphKind.Back:
                        g.DrawLines(pen, new PointF[]
                        {
                            new PointF(cx + 3, cy - 7),
                            new PointF(cx - 4, cy),
                            new PointF(cx + 3, cy + 7)
                        });
                        g.DrawLine(pen, cx - 4, cy, cx + 8, cy);
                        break;
                    case GlyphKind.Forward:
                        g.DrawLines(pen, new PointF[]
                        {
                            new PointF(cx - 3, cy - 7),
                            new PointF(cx + 4, cy),
                            new PointF(cx - 3, cy + 7)
                        });
                        g.DrawLine(pen, cx + 4, cy, cx - 8, cy);
                        break;
                    case GlyphKind.Reload:
                        g.DrawArc(pen, cx - 7, cy - 7, 14, 14, -60, 290);
                        g.DrawLine(pen, cx + 1, cy - 9, cx + 7, cy - 8);
                        g.DrawLine(pen, cx + 1, cy - 9, cx + 5, cy - 3);
                        break;
                    case GlyphKind.Stop:
                        g.DrawLine(pen, cx - 6, cy - 6, cx + 6, cy + 6);
                        g.DrawLine(pen, cx + 6, cy - 6, cx - 6, cy + 6);
                        break;
                    case GlyphKind.Home:
                        g.DrawLines(pen, new PointF[]
                        {
                            new PointF(cx - 8, cy),
                            new PointF(cx, cy - 8),
                            new PointF(cx + 8, cy)
                        });
                        g.DrawLine(pen, cx - 6, cy - 1, cx - 6, cy + 7);
                        g.DrawLine(pen, cx + 6, cy - 1, cx + 6, cy + 7);
                        g.DrawLine(pen, cx - 6, cy + 7, cx + 6, cy + 7);
                        break;
                }
            }
        }
    }

    // ---------------------------------------------------------------------
    // Dark chrome renderer for the ToolStrip and StatusStrip.
    // ---------------------------------------------------------------------
    internal sealed class DarkColorTable : ProfessionalColorTable
    {
        public override Color ToolStripGradientBegin { get { return Color.FromArgb(22, 22, 31); } }
        public override Color ToolStripGradientMiddle { get { return Color.FromArgb(22, 22, 31); } }
        public override Color ToolStripGradientEnd { get { return Color.FromArgb(22, 22, 31); } }
        public override Color ButtonSelectedHighlight { get { return Color.FromArgb(48, 44, 72); } }
        public override Color ButtonSelectedBorder { get { return Color.FromArgb(124, 58, 237); } }
        public override Color ButtonPressedHighlight { get { return Color.FromArgb(70, 52, 120); } }
        public override Color ButtonPressedBorder { get { return Color.FromArgb(139, 92, 246); } }
        public override Color ButtonCheckedGradientBegin { get { return Color.FromArgb(52, 42, 84); } }
        public override Color ButtonCheckedGradientEnd { get { return Color.FromArgb(52, 42, 84); } }
        public override Color MenuBorder { get { return Color.FromArgb(54, 54, 72); } }
        public override Color SeparatorDark { get { return Color.FromArgb(54, 54, 72); } }
        public override Color SeparatorLight { get { return Color.FromArgb(54, 54, 72); } }
        public override Color StatusStripGradientBegin { get { return Color.FromArgb(18, 18, 26); } }
        public override Color StatusStripGradientEnd { get { return Color.FromArgb(18, 18, 26); } }
    }

    internal sealed class DarkRenderer : ToolStripProfessionalRenderer
    {
        public DarkRenderer() : base(new DarkColorTable())
        {
            RoundedEdges = false;
        }

        protected override void OnRenderToolStripBackground(ToolStripRenderEventArgs e)
        {
            Color back = e.ToolStrip.BackColor;
            if (back.IsEmpty) back = Color.FromArgb(22, 22, 31);
            using (SolidBrush brush = new SolidBrush(back))
            {
                e.Graphics.FillRectangle(brush, e.AffectedBounds);
            }
        }

        protected override void OnRenderToolStripBorder(ToolStripRenderEventArgs e)
        {
            using (Pen pen = new Pen(Color.FromArgb(48, 48, 64)))
            {
                Rectangle r = e.ToolStrip.ClientRectangle;
                e.Graphics.DrawLine(pen, r.Left, r.Bottom - 1, r.Right, r.Bottom - 1);
            }
        }

        protected override void OnRenderButtonBackground(ToolStripItemRenderEventArgs e)
        {
            ToolStripButton button = e.Item as ToolStripButton;
            if (button == null) { base.OnRenderButtonBackground(e); return; }

            bool active = button.Pressed || button.Selected;
            if (!active) return;

            Color fill = button.Pressed
                ? Color.FromArgb(66, 52, 112)
                : Color.FromArgb(44, 40, 66);
            Rectangle bounds = new Rectangle(0, 0, e.Item.Width - 1, e.Item.Height - 1);
            using (SolidBrush brush = new SolidBrush(fill))
            using (Pen pen = new Pen(Color.FromArgb(96, 70, 168)))
            {
                e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
                FillRounded(e.Graphics, brush, bounds, 5);
                DrawRounded(e.Graphics, pen, bounds, 5);
            }
        }

        protected override void OnRenderItemText(ToolStripItemTextRenderEventArgs e)
        {
            e.TextColor = e.Item.Enabled ? e.Item.ForeColor : Color.FromArgb(110, 112, 128);
            base.OnRenderItemText(e);
        }

        protected override void OnRenderToolStripStatusLabelBackground(ToolStripItemRenderEventArgs e)
        {
            ToolStripStatusLabel label = e.Item as ToolStripStatusLabel;
            if (label != null && !label.BackColor.IsEmpty && label.BackColor != Color.Transparent)
            {
                using (SolidBrush brush = new SolidBrush(label.BackColor))
                {
                    e.Graphics.FillRectangle(brush, new Rectangle(Point.Empty, e.Item.Size));
                }
                return;
            }
            base.OnRenderToolStripStatusLabelBackground(e);
        }

        protected override void OnRenderSeparator(ToolStripSeparatorRenderEventArgs e)
        {
            int y = e.Item.Height / 2;
            using (Pen pen = new Pen(Color.FromArgb(58, 58, 78)))
            {
                e.Graphics.DrawLine(pen, 3, y, e.Item.Width - 3, y);
            }
        }

        protected override void OnRenderStatusStripSizingGrip(ToolStripRenderEventArgs e)
        {
            // No grip: the status bar is informational only.
        }

        private static void FillRounded(Graphics g, Brush brush, Rectangle bounds, int radius)
        {
            using (GraphicsPath path = RoundedPath(bounds, radius)) g.FillPath(brush, path);
        }

        private static void DrawRounded(Graphics g, Pen pen, Rectangle bounds, int radius)
        {
            using (GraphicsPath path = RoundedPath(bounds, radius)) g.DrawPath(pen, path);
        }

        private static GraphicsPath RoundedPath(Rectangle bounds, int radius)
        {
            GraphicsPath path = new GraphicsPath();
            int d = radius * 2;
            if (d <= 0) { path.AddRectangle(bounds); return path; }
            path.AddArc(bounds.Left, bounds.Top, d, d, 180, 90);
            path.AddArc(bounds.Right - d, bounds.Top, d, d, 270, 90);
            path.AddArc(bounds.Right - d, bounds.Bottom - d, d, d, 0, 90);
            path.AddArc(bounds.Left, bounds.Bottom - d, d, d, 90, 90);
            path.CloseFigure();
            return path;
        }
    }

    // ---------------------------------------------------------------------
    // COM event sink for DWebBrowserEvents2. This is how NewWindow3 is
    // intercepted: a target=_blank link is cancelled and re-opened in the
    // same window. If the sink cannot be connected, the managed NewWindow
    // event still cancels popups, but the URL is not available.
    // ---------------------------------------------------------------------
    [ComVisible(true)]
    [ClassInterface(ClassInterfaceType.AutoDispatch)]
    public sealed class BrowserEventSink
    {
        private readonly MainForm _form;

        public BrowserEventSink(MainForm form)
        {
            _form = form;
        }

        [DispId(273)]
        public void NewWindow3(ref object ppDisp, ref bool cancel, int dwFlags, string urlContext, string url)
        {
            cancel = true;
            ppDisp = null;
            try { _form.HandleNewWindow3(url); } catch { }
        }

        [DispId(251)]
        public void NewWindow2(ref object ppDisp, ref bool cancel)
        {
            cancel = true;
            ppDisp = null;
            try { _form.HandleNewWindow2(); } catch { }
        }
    }

    // ---------------------------------------------------------------------
    // The browser window.
    // ---------------------------------------------------------------------
    public sealed class MainForm : Form
    {
        private readonly Config _config;
        private readonly string _exeName;

        private WebBrowser _browser;
        private Panel _content;
        private Panel _overlay;
        private ToolStrip _toolbar;
        private GlyphButton _backButton;
        private GlyphButton _forwardButton;
        private GlyphButton _stopButton;
        private GlyphButton _homeButton;
        private ToolStripComboBox _address;
        private ToolStripComboBox _emulationBox;
        private ToolStripLabel _zoomLabel;
        private StatusStrip _status;
        private ToolStripStatusLabel _engineBadge;
        private ToolStripStatusLabel _statusText;
        private ToolStripStatusLabel _urlHint;
        private ToolStripStatusLabel _progressText;
        private ToolStripProgressBar _progress;
        private Label _overlayTitle;
        private Label _overlayMessage;
        private TextBox _overlayUrl;
        private Button _retryButton;

        private int _zoom = 100;
        private string _pendingUrl = "";
        private string _failedUrl = "";
        private string _pendingPopupUrl;
        private bool _comSinkReady;
        private object _sink;
        private IConnectionPoint _connectionPoint;
        private int _cookie = -1;
        private bool _navigating;

        internal MainForm(Config config, string startUrl, string exeName)
        {
            _config = config ?? new Config();
            _exeName = exeName ?? "iebox-host.exe";
            _zoom = _config.Zoom;

            SuspendLayout();
            BuildWindow();
            BuildToolbar();
            BuildStatusBar();
            BuildContent();
            ResumeLayout(true);

            ApplySavedBounds();
            WireEvents();

            _zoomLabel.Text = _zoom + "%";
            SelectEmulationInBox(_config.Emulation);

            NavigateTo(string.IsNullOrEmpty(startUrl) ? _config.HomeUrl : startUrl);
        }

        // ---- construction -------------------------------------------------

        private void BuildWindow()
        {
            Text = "iebox";
            BackColor = Color.FromArgb(18, 18, 26);
            ForeColor = Color.FromArgb(232, 233, 242);
            Font = new Font("Segoe UI", 9f);
            MinimumSize = new Size(720, 480);
            KeyPreview = true;
            DoubleBuffered = true;
            StartPosition = FormStartPosition.CenterScreen;
            try { Icon = SystemIcons.Application; } catch { }
        }

        private void BuildToolbar()
        {
            _toolbar = new ToolStrip();
            _toolbar.Dock = DockStyle.Top;
            _toolbar.GripStyle = ToolStripGripStyle.Hidden;
            _toolbar.Renderer = new DarkRenderer();
            _toolbar.BackColor = Color.FromArgb(22, 22, 31);
            _toolbar.ForeColor = Color.FromArgb(228, 230, 242);
            _toolbar.Padding = new Padding(6, 6, 6, 6);
            _toolbar.AutoSize = false;
            _toolbar.Height = 42;

            _backButton = MakeGlyph(GlyphKind.Back, "Back (Alt+Left)");
            _forwardButton = MakeGlyph(GlyphKind.Forward, "Forward (Alt+Right)");
            _stopButton = MakeGlyph(GlyphKind.Reload, "Stop / Reload (F5)");
            _homeButton = MakeGlyph(GlyphKind.Home, "Home");

            _address = new ToolStripComboBox();
            _address.AutoSize = false;
            _address.Width = 420;
            _address.IntegralHeight = false;
            _address.DropDownStyle = ComboBoxStyle.DropDown;
            _address.FlatStyle = FlatStyle.Flat;
            _address.BackColor = Color.FromArgb(38, 38, 52);
            _address.ForeColor = Color.FromArgb(236, 237, 246);
            _address.Margin = new Padding(4, 1, 4, 1);
            _address.ToolTipText = "Address (Ctrl+L)";

            ToolStripButton go = MakeText("Go", "Open the address (Enter)", 42);
            ToolStripButton modern = MakeText("Modern", "Open this URL in your default browser", 70);
            modern.ForeColor = Color.FromArgb(125, 211, 252);

            ToolStripButton zoomOut = MakeText("A-", "Zoom out (Ctrl+-)", 32);
            _zoomLabel = new ToolStripLabel("100%");
            _zoomLabel.ForeColor = Color.FromArgb(180, 184, 202);
            _zoomLabel.AutoSize = false;
            _zoomLabel.Width = 48;
            _zoomLabel.TextAlign = ContentAlignment.MiddleCenter;
            ToolStripButton zoomIn = MakeText("A+", "Zoom in (Ctrl++)", 32);

            _emulationBox = new ToolStripComboBox();
            _emulationBox.AutoSize = false;
            _emulationBox.Width = 82;
            _emulationBox.DropDownStyle = ComboBoxStyle.DropDownList;
            _emulationBox.FlatStyle = FlatStyle.Flat;
            _emulationBox.BackColor = Color.FromArgb(38, 38, 52);
            _emulationBox.ForeColor = Color.FromArgb(236, 237, 246);
            _emulationBox.Margin = new Padding(6, 1, 2, 1);
            _emulationBox.ToolTipText = "Document mode (writes HKCU for iebox-host.exe)";
            for (int i = 0; i < Emulation.Count; i++)
            {
                _emulationBox.Items.Add(Emulation.LabelAt(i));
            }

            _toolbar.Items.Add(_backButton);
            _toolbar.Items.Add(_forwardButton);
            _toolbar.Items.Add(_stopButton);
            _toolbar.Items.Add(_homeButton);
            _toolbar.Items.Add(new ToolStripSeparator());
            _toolbar.Items.Add(_address);
            _toolbar.Items.Add(go);
            _toolbar.Items.Add(modern);
            _toolbar.Items.Add(new ToolStripSeparator());
            _toolbar.Items.Add(zoomOut);
            _toolbar.Items.Add(_zoomLabel);
            _toolbar.Items.Add(zoomIn);
            _toolbar.Items.Add(new ToolStripSeparator());
            _toolbar.Items.Add(_emulationBox);

            _backButton.Click += delegate { GoBack(); };
            _forwardButton.Click += delegate { GoForward(); };
            _stopButton.Click += delegate { StopOrReload(); };
            _homeButton.Click += delegate { NavigateTo(_config.HomeUrl); };
            _address.KeyDown += AddressKeyDown;
            go.Click += delegate { NavigateTo(_address.Text); };
            modern.Click += delegate { OpenModern(); };
            zoomOut.Click += delegate { SetZoom(_zoom - 10); };
            zoomIn.Click += delegate { SetZoom(_zoom + 10); };
            _zoomLabel.Click += delegate { SetZoom(100); };
            _emulationBox.SelectedIndexChanged += EmulationChanged;

            Controls.Add(_toolbar);
        }

        private GlyphButton MakeGlyph(GlyphKind kind, string tooltip)
        {
            GlyphButton button = new GlyphButton();
            button.Kind = kind;
            button.ToolTipText = tooltip;
            return button;
        }

        private static ToolStripButton MakeText(string text, string tooltip, int width)
        {
            ToolStripButton button = new ToolStripButton(text);
            button.AutoSize = false;
            button.Size = new Size(width, 28);
            button.Margin = new Padding(2, 0, 2, 0);
            button.ToolTipText = tooltip;
            button.ForeColor = Color.FromArgb(214, 217, 232);
            return button;
        }

        private void BuildStatusBar()
        {
            _status = new StatusStrip();
            _status.Dock = DockStyle.Bottom;
            _status.SizingGrip = false;
            _status.Renderer = new DarkRenderer();
            _status.BackColor = Color.FromArgb(18, 18, 26);
            _status.ForeColor = Color.FromArgb(190, 194, 212);
            _status.Padding = new Padding(8, 2, 8, 2);
            _status.AutoSize = false;
            _status.Height = 28;

            _engineBadge = new ToolStripStatusLabel("Trident (legacy engine)");
            _engineBadge.BackColor = Color.FromArgb(91, 33, 182);
            _engineBadge.ForeColor = Color.White;
            _engineBadge.Font = new Font("Segoe UI Semibold", 8.5f, FontStyle.Bold);
            _engineBadge.AutoSize = false;
            _engineBadge.Width = 176;
            _engineBadge.TextAlign = ContentAlignment.MiddleCenter;
            _engineBadge.Margin = new Padding(0, 1, 10, 1);

            _statusText = new ToolStripStatusLabel("Ready");
            _statusText.Spring = true;
            _statusText.TextAlign = ContentAlignment.MiddleLeft;
            _statusText.ForeColor = Color.FromArgb(196, 200, 218);

            _progressText = new ToolStripStatusLabel("");
            _progressText.AutoSize = false;
            _progressText.Width = 48;
            _progressText.TextAlign = ContentAlignment.MiddleRight;
            _progressText.ForeColor = Color.FromArgb(150, 154, 174);

            _progress = new ToolStripProgressBar();
            _progress.AutoSize = false;
            _progress.Size = new Size(110, 12);
            _progress.Style = ProgressBarStyle.Continuous;
            _progress.Visible = false;
            _progress.Margin = new Padding(4, 4, 6, 3);

            _urlHint = new ToolStripStatusLabel("");
            _urlHint.AutoSize = false;
            _urlHint.Width = 220;
            _urlHint.TextAlign = ContentAlignment.MiddleRight;
            _urlHint.ForeColor = Color.FromArgb(140, 145, 168);

            _status.Items.Add(_engineBadge);
            _status.Items.Add(_statusText);
            _status.Items.Add(_progressText);
            _status.Items.Add(_progress);
            _status.Items.Add(_urlHint);

            Controls.Add(_status);
        }

        private void BuildContent()
        {
            _content = new Panel();
            _content.Dock = DockStyle.Fill;
            _content.BackColor = Color.FromArgb(18, 18, 26);

            _browser = new WebBrowser();
            _browser.Dock = DockStyle.Fill;
            _browser.ScriptErrorsSuppressed = true;
            _browser.AllowWebBrowserDrop = false;
            _browser.WebBrowserShortcutsEnabled = true;
            _browser.IsWebBrowserContextMenuEnabled = true;

            _overlay = new Panel();
            _overlay.Dock = DockStyle.Fill;
            _overlay.BackColor = Color.FromArgb(20, 20, 29);
            _overlay.Visible = false;
            BuildOverlay();

            _content.Controls.Add(_browser);
            _content.Controls.Add(_overlay);
            Controls.Add(_content);

            _overlay.BringToFront();
        }

        private void BuildOverlay()
        {
            TableLayoutPanel host = new TableLayoutPanel();
            host.Dock = DockStyle.Fill;
            host.BackColor = Color.FromArgb(20, 20, 29);
            host.ColumnCount = 1;
            host.RowCount = 1;
            host.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100f));

            Panel card = new Panel();
            card.AutoSize = true;
            card.AutoSizeMode = AutoSizeMode.GrowAndShrink;
            card.MaximumSize = new Size(680, 0);
            card.BackColor = Color.FromArgb(28, 28, 40);
            card.Padding = new Padding(30, 26, 30, 26);
            card.Anchor = AnchorStyles.None;

            TableLayoutPanel stack = new TableLayoutPanel();
            stack.AutoSize = true;
            stack.AutoSizeMode = AutoSizeMode.GrowAndShrink;
            stack.ColumnCount = 1;
            stack.Dock = DockStyle.Top;
            stack.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100f));

            _overlayTitle = new Label();
            _overlayTitle.Text = "This page could not be opened";
            _overlayTitle.Font = new Font("Segoe UI Semibold", 17f, FontStyle.Bold);
            _overlayTitle.ForeColor = Color.White;
            _overlayTitle.AutoSize = true;
            _overlayTitle.Margin = new Padding(0, 0, 0, 10);

            _overlayMessage = new Label();
            _overlayMessage.Text = "";
            _overlayMessage.Font = new Font("Segoe UI", 9.75f);
            _overlayMessage.ForeColor = Color.FromArgb(190, 194, 214);
            _overlayMessage.AutoSize = true;
            _overlayMessage.MaximumSize = new Size(600, 0);
            _overlayMessage.Margin = new Padding(0, 0, 0, 14);

            _overlayUrl = new TextBox();
            _overlayUrl.ReadOnly = true;
            _overlayUrl.BorderStyle = BorderStyle.FixedSingle;
            _overlayUrl.BackColor = Color.FromArgb(22, 22, 32);
            _overlayUrl.ForeColor = Color.FromArgb(170, 214, 255);
            _overlayUrl.Font = new Font("Consolas", 9f);
            _overlayUrl.Dock = DockStyle.Top;
            _overlayUrl.Width = 600;
            _overlayUrl.Margin = new Padding(0, 0, 0, 16);

            FlowLayoutPanel buttons = new FlowLayoutPanel();
            buttons.AutoSize = true;
            buttons.AutoSizeMode = AutoSizeMode.GrowAndShrink;
            buttons.FlowDirection = FlowDirection.LeftToRight;
            buttons.WrapContents = true;
            buttons.Margin = new Padding(0);

            _retryButton = MakeOverlayButton("Retry", true);
            _retryButton.Click += delegate { RetryFailed(); };
            Button modern = MakeOverlayButton("Open in modern browser", false);
            modern.Click += delegate { OpenModernUrl(_failedUrl); };
            Button copy = MakeOverlayButton("Copy URL", false);
            copy.Click += delegate
            {
                try { Clipboard.SetText(_failedUrl); SetStatus("URL copied to the clipboard."); }
                catch { SetStatus("Could not access the clipboard."); }
            };
            Button dismiss = MakeOverlayButton("Back to page", false);
            dismiss.Click += delegate { HideOverlay(); };

            buttons.Controls.Add(_retryButton);
            buttons.Controls.Add(modern);
            buttons.Controls.Add(copy);
            buttons.Controls.Add(dismiss);

            stack.RowCount = 4;
            stack.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            stack.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            stack.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            stack.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            stack.Controls.Add(_overlayTitle, 0, 0);
            stack.Controls.Add(_overlayMessage, 0, 1);
            stack.Controls.Add(_overlayUrl, 0, 2);
            stack.Controls.Add(buttons, 0, 3);

            card.Controls.Add(stack);
            host.Controls.Add(card, 0, 0);
            _overlay.Controls.Add(host);
        }

        private static Button MakeOverlayButton(string text, bool primary)
        {
            Button button = new Button();
            button.Text = text;
            button.AutoSize = true;
            button.AutoSizeMode = AutoSizeMode.GrowAndShrink;
            button.Padding = new Padding(14, 7, 14, 7);
            button.FlatStyle = FlatStyle.Flat;
            button.Font = new Font("Segoe UI Semibold", 9f, FontStyle.Bold);
            button.BackColor = primary ? Color.FromArgb(124, 58, 237) : Color.FromArgb(40, 40, 56);
            button.ForeColor = Color.White;
            button.FlatAppearance.BorderColor = primary ? Color.FromArgb(124, 58, 237) : Color.FromArgb(70, 70, 94);
            button.Margin = new Padding(0, 0, 8, 0);
            button.Cursor = Cursors.Hand;
            return button;
        }

        private void ApplySavedBounds()
        {
            try
            {
                Rectangle saved = new Rectangle(
                    _config.WindowX,
                    _config.WindowY,
                    _config.WindowWidth,
                    _config.WindowHeight);

                bool visible = false;
                if (_config.WindowX > -10000 && _config.WindowY > -10000)
                {
                    foreach (Screen screen in Screen.AllScreens)
                    {
                        Rectangle overlap = Rectangle.Intersect(screen.WorkingArea, saved);
                        if (overlap.Width >= 120 && overlap.Height >= 80) { visible = true; break; }
                    }
                }

                if (visible)
                {
                    StartPosition = FormStartPosition.Manual;
                    Bounds = saved;
                }
                if (_config.WindowMaximized) WindowState = FormWindowState.Maximized;
            }
            catch
            {
                StartPosition = FormStartPosition.CenterScreen;
            }
        }

        private void WireEvents()
        {
            _browser.Navigating += BrowserNavigating;
            _browser.Navigated += BrowserNavigated;
            _browser.DocumentCompleted += BrowserDocumentCompleted;
            _browser.DocumentTitleChanged += delegate { UpdateTitle(); };
            _browser.ProgressChanged += BrowserProgressChanged;
            _browser.StatusTextChanged += BrowserStatusTextChanged;
            _browser.NewWindow += BrowserNewWindow;
            _browser.CanGoBackChanged += delegate { UpdateNavigationButtons(); };
            _browser.CanGoForwardChanged += delegate { UpdateNavigationButtons(); };
            _browser.HandleCreated += delegate { StartComHook(); };
            Resize += delegate { LayoutToolbar(); };
            Shown += delegate
            {
                LayoutToolbar();
                StartComHook();
                try { _browser.Focus(); } catch { }
            };
            FormClosing += MainFormClosing;
            KeyDown += delegate(object sender, KeyEventArgs e)
            {
                if (e.KeyCode == Keys.Escape && _overlay.Visible) HideOverlay();
            };
        }

        // ---- com hook -----------------------------------------------------

        private void StartComHook()
        {
            if (_comSinkReady) return;
            try
            {
                object activeX = _browser.ActiveXInstance;
                if (activeX == null) return;

                IConnectionPointContainer container = activeX as IConnectionPointContainer;
                if (container == null) return;

                Guid diid = new Guid("34A715A0-6587-11D0-924A-0020AFC7AC4D"); // DWebBrowserEvents2
                IConnectionPoint point;
                container.FindConnectionPoint(ref diid, out point);
                if (point == null) return;

                BrowserEventSink sink = new BrowserEventSink(this);
                int cookie;
                point.Advise(sink, out cookie);
                _sink = sink;
                _connectionPoint = point;
                _cookie = cookie;
                _comSinkReady = true;
            }
            catch
            {
                _comSinkReady = false;
            }
        }

        private void ReleaseComHook()
        {
            try
            {
                if (_connectionPoint != null && _cookie >= 0)
                {
                    _connectionPoint.Unadvise(_cookie);
                }
            }
            catch { }
            _connectionPoint = null;
            _cookie = -1;
            _sink = null;
        }

        public void HandleNewWindow3(string url)
        {
            _pendingPopupUrl = url;
            if (string.IsNullOrEmpty(url))
            {
                SetStatus("Popup blocked. Use the address bar or the Modern button.");
                return;
            }
            SetStatus("Opening popup in this window: " + url);
            try
            {
                BeginInvoke((MethodInvoker)delegate { NavigateTo(url); });
            }
            catch { }
        }

        public void HandleNewWindow2()
        {
            SetStatus("Popup blocked. Use the address bar or the Modern button.");
        }

        // ---- navigation ---------------------------------------------------

        private void AddressKeyDown(object sender, KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Enter)
            {
                e.SuppressKeyPress = true;
                NavigateTo(_address.Text);
            }
            else if (e.KeyCode == Keys.Escape)
            {
                e.SuppressKeyPress = true;
                SyncAddress(_browser.Url);
                try { _browser.Focus(); } catch { }
            }
        }

        private void NavigateTo(string input)
        {
            string target = UrlInput.Normalize(input, _config.HomeUrl);
            Uri uri;
            if (!Uri.TryCreate(target, UriKind.Absolute, out uri))
            {
                ShowError(target, "That does not look like a URL the legacy engine can open.",
                    "Type an address such as http://intranet/, https://example.com/ or C:\\pages\\index.html.");
                return;
            }

            // The address bar is user input, but it should still not be a
            // script or shell URL. Only page schemes reach the engine.
            string scheme = uri.Scheme.ToLowerInvariant();
            if (scheme != "http" && scheme != "https" && scheme != "file" &&
                scheme != "ftp" && scheme != "about" && scheme != "data")
            {
                ShowError(target, "That URL scheme is not allowed.",
                    "iebox opens http, https, file, ftp, about and data URLs only.");
                return;
            }

            HideOverlay();
            _pendingUrl = target;
            try
            {
                _browser.Navigate(target);
            }
            catch (Exception ex)
            {
                ShowError(target, "The legacy engine rejected this address.", ex.Message);
            }
        }

        private void GoBack()
        {
            try { if (_browser.CanGoBack) _browser.GoBack(); } catch { }
        }

        private void GoForward()
        {
            try { if (_browser.CanGoForward) _browser.GoForward(); } catch { }
        }

        private void StopOrReload()
        {
            try
            {
                if (_navigating) _browser.Stop();
                else _browser.Refresh();
            }
            catch { }
        }

        private void BrowserNavigating(object sender, WebBrowserNavigatingEventArgs e)
        {
            _navigating = true;
            try
            {
                if (e.Url != null) _pendingUrl = e.Url.ToString();
                SetStatus("Loading " + _pendingUrl + " ...");
                _progress.Visible = true;
                _progress.Value = 5;
                _progressText.Text = "";
                _stopButton.Kind = GlyphKind.Stop;
                _stopButton.Invalidate();
                HideOverlay();
            }
            catch { }
        }

        private void BrowserNavigated(object sender, WebBrowserNavigatedEventArgs e)
        {
            try
            {
                if (!IsEngineErrorPage(e.Url))
                {
                    SyncAddress(e.Url);
                    UpdateUrlHint(e.Url);
                }
                UpdateNavigationButtons();

                if (IsEngineErrorPage(e.Url))
                {
                    ShowError(
                        string.IsNullOrEmpty(_failedUrl) ? _pendingUrl : _failedUrl,
                        "The legacy engine could not display this page. The site may require TLS 1.3, " +
                        "a modern cipher suite, or a browser feature that Trident never had.",
                        "Try the Modern button. Legacy intranet sites often still work; public HTTPS sites often do not.");
                }
            }
            catch { }
        }

        private void BrowserDocumentCompleted(object sender, WebBrowserDocumentCompletedEventArgs e)
        {
            _navigating = false;
            try
            {
                _progress.Visible = false;
                _progressText.Text = "";
                _stopButton.Kind = GlyphKind.Reload;
                _stopButton.Invalidate();
                UpdateTitle();
                if (!IsEngineErrorPage(e.Url))
                {
                    SyncAddress(_browser.Url);
                    UpdateUrlHint(_browser.Url);
                }

                if (IsEngineErrorPage(e.Url))
                {
                    ShowError(
                        string.IsNullOrEmpty(_failedUrl) ? _pendingUrl : _failedUrl,
                        "The legacy engine could not display this page. The site may require TLS 1.3, " +
                        "a modern cipher suite, or a browser feature that Trident never had.",
                        "Try the Modern button. Legacy intranet sites often still work; public HTTPS sites often do not.");
                }
                else
                {
                    SetStatus("Done");
                }
            }
            catch { }
        }

        private void BrowserProgressChanged(object sender, WebBrowserProgressChangedEventArgs e)
        {
            try
            {
                if (e.MaximumProgress <= 0) { _progress.Visible = false; return; }
                int percent = (int)(e.CurrentProgress * 100 / e.MaximumProgress);
                if (percent < 0) percent = 0;
                if (percent > 100) percent = 100;
                _progress.Visible = percent < 100;
                _progress.Value = percent;
                _progressText.Text = percent < 100 ? percent + "%" : "";
            }
            catch { }
        }

        private void BrowserStatusTextChanged(object sender, EventArgs e)
        {
            try
            {
                string text = _browser.StatusText;
                if (!string.IsNullOrEmpty(text)) _statusText.Text = text;
            }
            catch { }
        }

        private void BrowserNewWindow(object sender, System.ComponentModel.CancelEventArgs e)
        {
            // Always cancel the native IE popup. NewWindow3 (when the COM sink
            // is available) has already scheduled the URL in this window.
            e.Cancel = true;
            if (string.IsNullOrEmpty(_pendingPopupUrl))
            {
                SetStatus("Popup blocked. Use the address bar or the Modern button.");
            }
        }

        private void MainFormClosing(object sender, FormClosingEventArgs e)
        {
            try
            {
                ReleaseComHook();
                _config.LastUrl = _browser.Url != null ? _browser.Url.ToString() : _config.LastUrl;
                _config.Zoom = _zoom;

                Rectangle bounds = WindowState == FormWindowState.Maximized ? RestoreBounds : Bounds;
                _config.WindowX = bounds.X;
                _config.WindowY = bounds.Y;
                _config.WindowWidth = bounds.Width;
                _config.WindowHeight = bounds.Height;
                _config.WindowMaximized = WindowState == FormWindowState.Maximized;
                _config.Save();
            }
            catch { }
        }

        // ---- address / title / status -------------------------------------

        private void SyncAddress(Uri uri)
        {
            try
            {
                if (_address.ComboBox.Focused) return;
                if (uri == null) return;
                string text = uri.AbsoluteUri;
                if (text == "about:blank") return;
                _address.Text = text;
            }
            catch { }
        }

        private void UpdateTitle()
        {
            try
            {
                string title = _browser.DocumentTitle;
                if (string.IsNullOrEmpty(title) || title == "about:blank")
                {
                    Text = "iebox \u2014 legacy Trident browser";
                }
                else
                {
                    Text = title + " \u2014 iebox";
                }
            }
            catch
            {
                Text = "iebox \u2014 legacy Trident browser";
            }
        }

        private void UpdateUrlHint(Uri uri)
        {
            try
            {
                if (uri == null) { _urlHint.Text = ""; return; }
                string scheme = uri.Scheme;
                string host = uri.Host;
                if (scheme == "file") _urlHint.Text = "local file";
                else if (scheme == "https") _urlHint.Text = "https \u00b7 legacy TLS stack";
                else if (scheme == "http") _urlHint.Text = "http \u00b7 not encrypted";
                else _urlHint.Text = scheme + "://" + host;
            }
            catch { }
        }

        private void UpdateNavigationButtons()
        {
            try
            {
                _backButton.Enabled = _browser.CanGoBack;
                _forwardButton.Enabled = _browser.CanGoForward;
                _forwardButton.Invalidate();
                _backButton.Invalidate();
            }
            catch { }
        }

        private void SetStatus(string text)
        {
            try { _statusText.Text = text; } catch { }
        }

        private void LayoutToolbar()
        {
            try
            {
                int used = _toolbar.Padding.Horizontal + 10;
                foreach (ToolStripItem item in _toolbar.Items)
                {
                    if (!item.Visible || item == _address) continue;
                    used += item.Width + item.Margin.Horizontal;
                }

                int width = _toolbar.ClientSize.Width - used - 10;
                if (width < 160) width = 160;
                if (_address.Width != width)
                {
                    _address.AutoSize = false;
                    _address.Width = width;
                    _toolbar.PerformLayout();
                }
            }
            catch { }
        }

        // ---- error overlay ------------------------------------------------

        private static bool IsEngineErrorPage(Uri uri)
        {
            if (uri == null) return false;
            try
            {
                if (string.Equals(uri.Scheme, "res", StringComparison.OrdinalIgnoreCase)) return true;
                return uri.Host != null && uri.Host.IndexOf("ieframe", StringComparison.OrdinalIgnoreCase) >= 0;
            }
            catch { return false; }
        }

        private void ShowError(string url, string message, string detail)
        {
            _failedUrl = UrlInput.Normalize(url, _config.HomeUrl);
            _overlayTitle.Text = "This page could not be opened";
            _overlayMessage.Text = message + "\r\n\r\n" + detail;
            _overlayUrl.Text = _failedUrl;
            _overlay.Visible = true;
            _overlay.BringToFront();
            SetStatus("Navigation failed");
            try { _retryButton.Focus(); } catch { }
        }

        private void HideOverlay()
        {
            try
            {
                _overlay.Visible = false;
                _content.PerformLayout();
            }
            catch { }
        }

        private void RetryFailed()
        {
            string url = _failedUrl;
            HideOverlay();
            if (!string.IsNullOrEmpty(url)) NavigateTo(url);
        }

        // ---- modern browser / print / zoom --------------------------------

        private void OpenModern()
        {
            string url = null;
            try
            {
                if (_overlay.Visible && !string.IsNullOrEmpty(_failedUrl))
                {
                    url = _failedUrl;
                }
                else if (_browser.Url != null)
                {
                    url = _browser.Url.ToString();
                }
                if (string.IsNullOrEmpty(url) || url == "about:blank") url = _address.Text;
            }
            catch { }
            OpenModernUrl(url);
        }

        private void OpenModernUrl(string url)
        {
            try
            {
                string target = UrlInput.Normalize(url, _config.HomeUrl);
                Uri uri;
                if (!Uri.TryCreate(target, UriKind.Absolute, out uri))
                {
                    SetStatus("No valid URL to open in the default browser.");
                    return;
                }
                string scheme = uri.Scheme.ToLowerInvariant();
                if (scheme != "http" && scheme != "https" && scheme != "file" && scheme != "ftp")
                {
                    SetStatus("There is no web URL to open in the default browser.");
                    return;
                }
                ProcessStartInfo info = new ProcessStartInfo(target);
                info.UseShellExecute = true;
                Process.Start(info);
                SetStatus("Opened in your default browser.");
            }
            catch (Exception ex)
            {
                SetStatus("Could not open the default browser: " + ex.Message);
            }
        }

        private void PrintPage()
        {
            // OLECMDID_PRINT = 6, OLECMDEXECOPT_PROMPTUSER = 1
            if (!ExecCommand(6, 1, null))
            {
                try { _browser.Print(); } catch { SetStatus("Printing is not available for this page."); }
            }
        }

        private void SetZoom(int percent)
        {
            if (percent < 25) percent = 25;
            if (percent > 400) percent = 400;
            _zoom = percent;

            // OLECMDID_OPTICAL_ZOOM = 63, OLECMDEXECOPT_DONTPROMPTUSER = 2
            bool ok = ExecCommand(63, 2, percent);
            if (!ok) ApplyCssZoom(percent);

            _zoomLabel.Text = percent + "%";
            _config.Zoom = percent;
        }

        private bool ExecCommand(int command, int option, object input)
        {
            try
            {
                object activeX = _browser.ActiveXInstance;
                if (activeX == null) return false;
                object[] arguments = new object[] { command, option, input, null };
                activeX.GetType().InvokeMember(
                    "ExecWB",
                    BindingFlags.InvokeMethod,
                    null,
                    activeX,
                    arguments);
                return true;
            }
            catch
            {
                return false;
            }
        }

        private bool ApplyCssZoom(int percent)
        {
            try
            {
                object document = _browser.Document;
                if (document == null) return false;
                object body = document.GetType().InvokeMember("body", BindingFlags.GetProperty, null, document, null);
                if (body == null) return false;
                object style = body.GetType().InvokeMember("style", BindingFlags.GetProperty, null, body, null);
                if (style == null) return false;
                style.GetType().InvokeMember(
                    "zoom",
                    BindingFlags.SetProperty,
                    null,
                    style,
                    new object[] { percent.ToString(CultureInfo.InvariantCulture) + "%" });
                return true;
            }
            catch
            {
                return false;
            }
        }

        // ---- emulation ----------------------------------------------------

        private void SelectEmulationInBox(string emulation)
        {
            int index = Emulation.IndexOf(emulation);
            if (index < 0) index = Emulation.IndexOf(Emulation.Default);
            try
            {
                _emulationBox.SelectedIndexChanged -= EmulationChanged;
                _emulationBox.SelectedIndex = index;
                _emulationBox.SelectedIndexChanged += EmulationChanged;
            }
            catch { }
        }

        private void EmulationChanged(object sender, EventArgs e)
        {
            try
            {
                int index = _emulationBox.SelectedIndex;
                if (index < 0) return;
                string name = Emulation.NameAt(index);
                int value = Emulation.Value(name);
                bool ok = Emulation.Apply(_exeName, value);

                _config.Emulation = name;
                _config.Save();

                if (ok)
                {
                    SetStatus("Document mode " + Emulation.Label(name) + " (" + value + ") written to HKCU. Reloading...");
                }
                else
                {
                    SetStatus("Could not write HKCU emulation value; the page will reload with the previous mode.");
                }

                try { _browser.Refresh(WebBrowserRefreshOption.Completely); } catch { }

                // The engine mode is selected when the WebBrowser is created.
                // A full restart is the only guaranteed way to switch it.
                MessageBox.Show(
                    "The document mode was saved for " + _exeName + ".\r\n\r\n" +
                    "The WebBrowser control reads this value when it is created, so restart iebox " +
                    "if the page still reports the old mode.\r\n\r\n" +
                    "Selected: " + Emulation.Label(name) + " (" + value + ")",
                    "iebox - document mode",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information);
            }
            catch { }
        }

        // ---- keyboard -----------------------------------------------------

        protected override bool ProcessCmdKey(ref Message msg, Keys keyData)
        {
            try
            {
                if (keyData == (Keys.Control | Keys.L))
                {
                    _address.Focus();
                    _address.ComboBox.Focus();
                    _address.ComboBox.SelectAll();
                    return true;
                }
                if (keyData == (Keys.Alt | Keys.Left)) { GoBack(); return true; }
                if (keyData == (Keys.Alt | Keys.Right)) { GoForward(); return true; }
                if (keyData == Keys.F5 || keyData == (Keys.Control | Keys.R)) { StopOrReload(); return true; }
                if (keyData == (Keys.Control | Keys.D0) || keyData == (Keys.Control | Keys.NumPad0)) { SetZoom(100); return true; }
                if (keyData == (Keys.Control | Keys.Oemplus) || keyData == (Keys.Control | Keys.Shift | Keys.Oemplus) || keyData == (Keys.Control | Keys.Add)) { SetZoom(_zoom + 10); return true; }
                if (keyData == (Keys.Control | Keys.OemMinus) || keyData == (Keys.Control | Keys.Subtract)) { SetZoom(_zoom - 10); return true; }
                if (keyData == (Keys.Control | Keys.P)) { PrintPage(); return true; }
                if (keyData == Keys.Escape) { try { _browser.Stop(); } catch { } return true; }
            }
            catch { }
            return base.ProcessCmdKey(ref msg, keyData);
        }
    }
}
