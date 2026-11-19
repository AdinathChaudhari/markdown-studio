import Cocoa
import WebKit

/// Avoids the WKUserContentController -> handler retain cycle.
final class WeakScriptHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ t: WKScriptMessageHandler) { target = t }
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        target?.userContentController(c, didReceive: m)
    }
}

final class DocumentWindowController: NSWindowController, NSWindowDelegate, WKScriptMessageHandler,
                                      WKNavigationDelegate, WKUIDelegate, NSSearchFieldDelegate {
    static let pageURL = URL(string: "mdstudio://app/index.html")!

    let webView: DropWebView
    private(set) var isReady = false
    /// True once the first `load` reply came back (used by the selftest).
    private(set) var loadCompleted = false
    private var pending: [() -> Void] = []

    private let findField = NSSearchField()
    private let findAccessory = NSTitlebarAccessoryViewController()

    private var doc: Document? { document as? Document }

    init(document: Document) {
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = selfTestPaths == nil ? .default() : .nonPersistent()
        let handler = SchemeHandler(folder: { [weak document] in document?.fileURL?.deletingLastPathComponent() })
        cfg.setURLSchemeHandler(handler, forURLScheme: "mdstudio")
        webView = DropWebView(frame: NSRect(x: 0, y: 0, width: 1100, height: 760), configuration: cfg)

        let win = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 760),
                           styleMask: [.titled, .closable, .miniaturizable, .resizable],
                           backing: .buffered, defer: false)
        win.minSize = NSSize(width: 640, height: 400)
        win.isRestorable = false
        win.contentView = webView
        super.init(window: win)
        win.delegate = self
        shouldCascadeWindows = true
        win.setFrameAutosaveName("MDStudioDocument")
        win.isReleasedWhenClosed = false

        cfg.userContentController.add(WeakScriptHandler(self), name: "mdstudio")
        webView.navigationDelegate = self
        webView.uiDelegate = self
        if ProcessInfo.processInfo.environment["MDSTUDIO_DEBUG"] != nil, #available(macOS 13.3, *) {
            webView.isInspectable = true
        }
        setupFindBar()
        webView.load(URLRequest(url: Self.pageURL))
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    deinit {
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "mdstudio")
    }

    // MARK: JS calls

    /// Runs `body` once the page has said `ready`; queued until then.
    func call(_ body: String, args: [String: Any] = [:], completion: ((Result<Any?, Error>) -> Void)? = nil) {
        let run = { [weak self] in
            guard let self = self else {
                completion?(.failure(NSError(domain: "MarkdownStudio", code: 5,
                    userInfo: [NSLocalizedDescriptionKey: "window closed"])))
                return
            }
            self.webView.callAsyncJavaScript(body, arguments: args, in: nil, in: .page) { result in
                switch result {
                case .success(let v): completion?(.success(v))
                case .failure(let e): completion?(.failure(e))
                }
            }
        }
        if isReady { run() } else { pending.append(run) }
    }

    func pushLoad() {
        guard isReady, let d = doc else { return }
        call("return window.__mdstudio.native.load(text, name);",
             args: ["text": d.text, "name": d.pageName]) { [weak self] result in
            guard let self = self else { return }
            self.loadCompleted = true
            switch result {
            case .success(let v) where (v as? Bool) == true:
                self.loadError = nil
                self.doc?.loadBlockedReason = nil
            case .success:
                self.loadFailed("The editor refused this file (it looks like a binary file), so it was not loaded.")
            case .failure(let e):
                self.loadFailed("The editor could not load this file: \(e.localizedDescription)")
            }
        }
    }

    private(set) var loadError: String?

    private func loadFailed(_ why: String) {
        loadError = why
        doc?.loadBlockedReason = why   // Document.save / data(ofType:) now refuse: never write '' over the file
        SelfTest.log(why)
        guard selfTestPaths == nil, let w = window else { return }   // selftest must never open a dialog
        let err = NSError(domain: "MarkdownStudio", code: 6, userInfo: [NSLocalizedDescriptionKey: why])
        w.presentError(err, modalFor: w, delegate: nil, didPresent: nil, contextInfo: nil)
    }

    func fetchText(_ done: @escaping (Result<String, Error>) -> Void) {
        call("return window.__mdstudio.native.getText();") { result in
            switch result {
            case .failure(let e): done(.failure(e))
            case .success(let v):
                if let s = v as? String { done(.success(s)) }
                else { done(.failure(NSError(domain: "MarkdownStudio", code: 3,
                        userInfo: [NSLocalizedDescriptionKey: "editor did not return text"]))) }
            }
        }
    }

    func markSaved(name: String) {
        call("return window.__mdstudio.native.markSaved(name);", args: ["name": name])
    }

    func runCommand(_ id: String) {
        call("return window.__mdstudio.native.command(id);", args: ["id": id])
    }

    @objc func mdCommand(_ sender: Any?) {
        if let item = sender as? NSMenuItem, let id = item.representedObject as? String { runCommand(id) }
    }

    /// WKWebView does not answer undo:/redo: (checked), so drive the page's own undo stack.
    @objc func mdUndo(_ sender: Any?) { webView.evaluateJavaScript("document.execCommand('undo')", completionHandler: nil) }
    @objc func mdRedo(_ sender: Any?) { webView.evaluateJavaScript("document.execCommand('redo')", completionHandler: nil) }

    // MARK: JS -> native

    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
        // Only the app page itself may talk to native: top frame, mdstudio://app.
        let origin = message.frameInfo.securityOrigin
        guard message.frameInfo.isMainFrame, origin.protocol == "mdstudio", origin.host == "app" else { return }
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "ready":
            isReady = true
            pushLoad()
            let queued = pending; pending = []
            queued.forEach { $0() }
        case "dirty":
            doc?.updateChangeCount((body["dirty"] as? Bool ?? false) ? .changeDone : .changeCleared)
        case "open": NSDocumentController.shared.openDocument(nil)
        case "new": NSDocumentController.shared.newDocument(nil)
        case "save": doc?.save(nil)
        case "print": doc?.printDocument(nil)
        case "copy":
            if let t = body["text"] as? String {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(t, forType: .string)
            }
        case "theme":
            switch body["theme"] as? String {
            case "light": window?.appearance = NSAppearance(named: .aqua)
            case "dark": window?.appearance = NSAppearance(named: .darkAqua)
            default: window?.appearance = nil
            }
        default: break
        }
    }

    // MARK: Navigation

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        if action.targetFrame?.isMainFrame ?? true, Self.sameIgnoringFragment(url, Self.pageURL) {
            // The initial/reload load is a programmatic `.other` navigation. A same-page jump is
            // fragment-only. Anything else resolving to the app page (a clicked relative link, a
            // form) would reload the editor and drop unsaved text, so cancel it.
            if action.navigationType == .other || (url.fragment != nil && action.navigationType != .formSubmitted) {
                decisionHandler(.allow); return
            }
            decisionHandler(.cancel); return
        }
        if action.targetFrame != nil, !(action.targetFrame!.isMainFrame) { decisionHandler(.allow); return }
        if action.navigationType == .linkActivated {
            let scheme = url.scheme?.lowercased() ?? ""
            if ["http", "https", "mailto"].contains(scheme) {
                NSWorkspace.shared.open(url)
            } else if scheme == "mdstudio", let base = doc?.fileURL?.deletingLastPathComponent() {
                // Same containment as SchemeHandler: inside the document folder, symlinks resolved.
                let root = base.resolvingSymlinksInPath().standardizedFileURL
                let rel = String(url.path.drop(while: { $0 == "/" }))
                let target = root.appendingPathComponent(rel).resolvingSymlinksInPath().standardizedFileURL
                if target.path.hasPrefix(root.path + "/"), FileManager.default.fileExists(atPath: target.path) {
                    // Only text documents open in the app; anything else (apps, scripts, .command...)
                    // is only revealed in Finder, never launched.
                    if ["md", "markdown", "mdown", "txt"].contains(target.pathExtension.lowercased()) {
                        NSDocumentController.shared.openDocument(withContentsOf: target, display: true) { _, _, e in
                            if let e = e { NSApp.presentError(e) }
                        }
                    } else { NSWorkspace.shared.activateFileViewerSelecting([target]) }
                }
            }
        }
        decisionHandler(.cancel)
    }

    private static func sameIgnoringFragment(_ a: URL, _ b: URL) -> Bool {
        var x = URLComponents(url: a, resolvingAgainstBaseURL: false)
        var y = URLComponents(url: b, resolvingAgainstBaseURL: false)
        x?.fragment = nil; y?.fragment = nil
        return x?.url == y?.url
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        isReady = false
        loadCompleted = false
        webView.load(URLRequest(url: Self.pageURL))   // second `ready` re-pushes cached text
    }

    // MARK: UI delegate

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url, ["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? "") {
            NSWorkspace.shared.open(url)
        }
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        present(message, buttons: ["OK"]) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        present(message, buttons: ["OK", "Cancel"]) { completionHandler($0 == .alertFirstButtonReturn) }
    }

    private func present(_ message: String, buttons: [String], _ done: @escaping (NSApplication.ModalResponse) -> Void) {
        let a = NSAlert()
        a.messageText = message
        buttons.forEach { a.addButton(withTitle: $0) }
        if let w = window { a.beginSheetModal(for: w, completionHandler: done) } else { done(a.runModal()) }
    }

    // MARK: Find

    private func setupFindBar() {
        findField.placeholderString = "Find in page"
        findField.sendsSearchStringImmediately = false
        findField.target = self
        findField.action = #selector(findNextFromField(_:))
        findField.delegate = self
        let box = NSView(frame: NSRect(x: 0, y: 0, width: 400, height: 34))
        findField.frame = NSRect(x: 12, y: 5, width: 260, height: 24)
        findField.autoresizingMask = [.maxXMargin]
        box.addSubview(findField)
        findAccessory.view = box
        findAccessory.layoutAttribute = .bottom
        findAccessory.isHidden = true
        window?.addTitlebarAccessoryViewController(findAccessory)
    }

    @objc func mdFind(_ sender: Any?) {
        findAccessory.isHidden = false
        window?.makeFirstResponder(findField)
        findField.selectText(nil)
    }

    @objc func mdFindNext(_ sender: Any?) { runFind(backwards: false) }
    @objc func mdFindPrevious(_ sender: Any?) { runFind(backwards: true) }
    @objc private func findNextFromField(_ sender: Any?) {
        let back = NSApp.currentEvent?.modifierFlags.contains(.shift) ?? false
        runFind(backwards: back)
    }

    private func runFind(backwards: Bool) {
        let s = findField.stringValue
        guard !s.isEmpty else { NSSound.beep(); return }
        let cfg = WKFindConfiguration()
        cfg.wraps = true
        cfg.backwards = backwards
        webView.find(s, configuration: cfg) { result in
            if !result.matchFound { NSSound.beep() }
        }
    }

    func control(_ control: NSControl, textView: NSTextView, doCommandBy sel: Selector) -> Bool {
        if sel == #selector(NSResponder.cancelOperation(_:)) {
            findAccessory.isHidden = true
            window?.makeFirstResponder(webView)
            return true
        }
        return false
    }

    // MARK: Window

    func windowWillClose(_ notification: Notification) {
        pending.removeAll()
    }
}
