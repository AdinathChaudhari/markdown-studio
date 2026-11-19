import Cocoa

// Hand-parsed: `MarkdownStudio --selftest <in.md> <out.md>`
var selfTestPaths: (input: URL, output: URL)? = nil
let argv = CommandLine.arguments
if let i = argv.firstIndex(of: "--selftest") {
    guard argv.count >= i + 3 else {
        FileHandle.standardError.write(Data("usage: --selftest <in.md> <out.md>\n".utf8))
        exit(2)
    }
    selfTestPaths = (URL(fileURLWithPath: argv[i + 1]), URL(fileURLWithPath: argv[i + 2]))
    // AppKit otherwise treats the trailing argv paths as documents to open and
    // NSDocumentController itself (not the delegate) shows "The file doesn't
    // exist" for the not-yet-written <out.md> — one modal per selftest run.
    // Registration domain only: in-memory, never written to the app's prefs.
    UserDefaults.standard.register(defaults: ["NSTreatUnknownArgumentsAsOpen": "NO"])
}

let app = NSApplication.shared
// Must exist before anything touches NSDocumentController.shared.
_ = DocumentController()
let appDelegate = AppDelegate()
app.delegate = appDelegate
app.setActivationPolicy(selfTestPaths == nil ? .regular : .accessory)
app.run()
