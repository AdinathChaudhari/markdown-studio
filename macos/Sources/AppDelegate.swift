import Cocoa

final class AppDelegate: NSObject, NSApplicationDelegate {
    var isSelfTest: Bool { selfTestPaths != nil }

    func applicationWillFinishLaunching(_ notification: Notification) {
        NSApp.mainMenu = MainMenuBuilder.build(openRecentTarget: self)
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        if let paths = selfTestPaths {
            SelfTest.start(input: paths.input, output: paths.output)
        }
    }

    func applicationShouldOpenUntitledFile(_ sender: NSApplication) -> Bool { !isSelfTest }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func application(_ application: NSApplication, open urls: [URL]) {
        guard !isSelfTest else { return }   // AppKit passes the trailing out.md argv here
        urls.forEach(openURL)
    }

    func application(_ sender: NSApplication, openFiles filenames: [String]) {
        guard !isSelfTest else { sender.reply(toOpenOrPrint: .cancel); return }
        filenames.forEach { openURL(URL(fileURLWithPath: $0)) }
        sender.reply(toOpenOrPrint: .success)
    }

    func openURL(_ url: URL) {
        NSDocumentController.shared.openDocument(withContentsOf: url, display: true) { _, _, error in
            if let error = error { NSApp.presentError(error) }
        }
    }

    @objc func openRecent(_ sender: NSMenuItem) {
        if let url = sender.representedObject as? URL { openURL(url) }
    }

    @objc func openDemo(_ sender: Any?) {
        do {
            let doc = try NSDocumentController.shared.openUntitledDocumentAndDisplay(true)
            if let d = doc as? Document {
                d.keepWhenOpeningFiles = true
                d.windowController?.runCommand("demo")
            }
        } catch { NSApp.presentError(error) }
    }
}
