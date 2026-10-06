using System;
using System.Diagnostics;
using System.IO;
using System.Linq;

internal static class Program
{
    private static string Quote(string value)
    {
        if (value.Length > 0 && value.All(c => !char.IsWhiteSpace(c) && c != '"'))
            return value;

        var result = "\"";
        var backslashes = 0;
        foreach (var character in value)
        {
            if (character == '\\')
            {
                backslashes++;
                continue;
            }

            if (character == '"')
            {
                result += new string('\\', backslashes * 2 + 1) + '"';
                backslashes = 0;
                continue;
            }

            result += new string('\\', backslashes) + character;
            backslashes = 0;
        }

        return result + new string('\\', backslashes * 2) + '"';
    }

    public static int Main(string[] args)
    {
        var root = AppDomain.CurrentDomain.BaseDirectory;
        var bundledNode = Path.Combine(root, "runtime", "node.exe");
        var node = File.Exists(bundledNode) ? bundledNode : "node.exe";
        var cli = Path.Combine(root, "app", "node_modules", "copilot-changelog-cli", "dist", "cli.js");
        if (!File.Exists(cli))
        {
            Console.Error.WriteLine("The Copilot Changelog CLI installation is incomplete.");
            return 2;
        }

        var arguments = string.Join(" ", new[] { Quote(cli) }.Concat(args.Select(Quote)));
        try
        {
            using (var process = Process.Start(new ProcessStartInfo
            {
                FileName = node,
                Arguments = arguments,
                UseShellExecute = false,
                WorkingDirectory = Environment.CurrentDirectory
            }))
            {
                if (process == null)
                    return 2;
                process.WaitForExit();
                return process.ExitCode;
            }
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("Unable to start the bundled Node.js runtime: " + error.Message);
            return 2;
        }
    }
}
