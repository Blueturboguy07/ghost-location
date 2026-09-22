using System;

// A stand-in for a real Windows adb.exe talking to one real, physically
// connected, USB-debugging-authorized Android phone. It answers the exact
// subset of commands AndroidAdapter (backend/android.mjs) issues, shaped
// like real `adb devices -l` / `adb shell getprop` output for an authorized
// USB phone -- matching the reporter's description (OS detected the phone,
// USB debugging prompt accepted -> adb state "device", not "unauthorized" or
// absent). This is a real, separately-compiled native Windows executable
// (Node's child_process.spawn with shell:false, which Ghost itself uses,
// refuses to launch a .cmd/.bat directly on Windows -- EINVAL -- so a batch
// wrapper cannot stand in for adb.exe here; only a real .exe can).
//
// It does NOT and CANNOT simulate any OS/USB-driver-level condition -- only
// the text-level contract between adb and Ghost's parser.
class MockAdb {
    static int Main(string[] args) {
        string serial = Environment.GetEnvironmentVariable("MOCK_ADB_SERIAL");
        if (string.IsNullOrEmpty(serial)) serial = "R3CX70ABCDE";
        string joined = string.Join(" ", args);

        if (joined == "version") {
            Console.Out.Write("Android Debug Bridge version 1.0.41\nVersion 37.0.1-12345678\nInstalled as C:\\mock\\adb.exe\n");
            return 0;
        }
        if (joined == "devices -l") {
            if (Environment.GetEnvironmentVariable("MOCK_ADB_EMPTY") == "1") {
                Console.Out.Write("List of devices attached\n\n");
            } else {
                Console.Out.Write("List of devices attached\n" + serial + "\tdevice usb:2-3 product:Spacewar model:A065 device:Spacewar transport_id:4\n\n");
            }
            return 0;
        }
        if (args.Length >= 3 && args[0] == "-s" && args[2] == "shell") {
            string shellArgs = string.Join(" ", args, 3, args.Length - 3);
            if (shellArgs == "getprop ro.build.version.sdk") { Console.Out.Write("34\n"); return 0; }
            if (shellArgs == "getprop ro.build.version.release") { Console.Out.Write("14\n"); return 0; }
            if (shellArgs == "pm path io.appium.settings") { return 1; } // helper not installed yet (pre-Prepare)
            Console.Error.Write("mock-adb: unhandled shell command: " + shellArgs + "\n");
            return 1;
        }
        if (args.Length >= 3 && args[0] == "-s" && args[2] == "get-devpath") {
            Console.Out.Write("usb:2-3\n");
            return 0;
        }
        Console.Error.Write("mock-adb: unhandled command: " + joined + "\n");
        return 1;
    }
}
