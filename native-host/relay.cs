// Native messaging host. It only passes bytes between the browser and the app, which does all the
// checking. If it cannot reach the app it exits, and the extension lets the browser carry on.
using System;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading;

static class Relay
{
    static int Main(string[] args)
    {
        string[] config;
        try
        {
            config = File.ReadAllLines(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "host-config.txt"));
        }
        catch (Exception)
        {
            return 2;
        }
        // ReadAllLines drops trailing empty lines, so the app command lines are optional.
        if (config.Length < 2) return 2;
        string pipeName = config[0], token = config[1];
        string appExe = config.Length > 2 ? config[2] : "";
        string appArgs = config.Length > 3 ? config[3] : "";

        string origin = "";
        foreach (string arg in args)
        {
            if (arg.StartsWith("chrome-extension://", StringComparison.Ordinal)) origin = arg;
        }

        NamedPipeClientStream pipe = Connect(pipeName, appExe, appArgs);
        if (pipe == null) return 3;

        byte[] hello = Encoding.UTF8.GetBytes("{\"type\":\"hello\",\"token\":\"" + token + "\",\"origin\":\"" + origin + "\"}");
        pipe.Write(BitConverter.GetBytes(hello.Length), 0, 4);
        pipe.Write(hello, 0, hello.Length);
        pipe.Flush();

        using (Stream stdin = Console.OpenStandardInput())
        using (Stream stdout = Console.OpenStandardOutput())
        {
            ManualResetEvent done = new ManualResetEvent(false);
            Start(stdin, pipe, done);
            Start(pipe, stdout, done);
            done.WaitOne();
        }
        return 0;
    }

    static NamedPipeClientStream Connect(string pipeName, string appExe, string appArgs)
    {
        NamedPipeClientStream pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
        try
        {
            pipe.Connect(300);
            return pipe;
        }
        catch (TimeoutException) { }
        catch (IOException) { }

        if (appExe.Length > 0)
        {
            try
            {
                ProcessStartInfo start = new ProcessStartInfo(appExe, appArgs);
                // Shell execute keeps this process's stdio handles out of the app.
                start.UseShellExecute = true;
                Process.Start(start);
            }
            catch (Exception)
            {
                return null;
            }
        }
        try
        {
            pipe.Connect(10000);
            return pipe;
        }
        catch (TimeoutException) { }
        catch (IOException) { }
        return null;
    }

    static void Start(Stream from, Stream to, ManualResetEvent done)
    {
        Thread thread = new Thread(delegate ()
        {
            byte[] buffer = new byte[65536];
            try
            {
                int count;
                while ((count = from.Read(buffer, 0, buffer.Length)) > 0)
                {
                    to.Write(buffer, 0, count);
                    to.Flush();
                }
            }
            catch (Exception) { }
            done.Set();
        });
        thread.IsBackground = true;
        thread.Start();
    }
}
