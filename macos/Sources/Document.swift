import Cocoa
import WebKit

@objc(MDDocument)
final class Document: NSDocument {
    /// Last text known to native: what was read from disk, or what getText returned for a save.
    var text = ""
    /// Dominant line ending of the file as read ("\n", "\r\n" or "\r"); the editor text is always LF.
    var lineEnding = "\n"
    /// True when the file began with a UTF-8 BOM; written back on save.
    var hadBOM = false
    /// Set by the window controller when the editor refused/failed to load the file. While set, every
    /// save is refused: the editor is empty and writing it would destroy the file on disk.
    var loadBlockedReason: String?
    var keepWhenOpeningFiles = false

    static func notLoadedError() -> NSError {
        NSError(domain: "MarkdownStudio", code: 7, userInfo: [NSLocalizedDescriptionKey:
            "not loaded \u{2014} refusing to overwrite. The editor could not load this file, so saving would replace it with an empty document."])
    }

    var windowController: DocumentWindowController? { windowControllers.first as? DocumentWindowController }
    var pageName: String { fileURL?.lastPathComponent ?? "Untitled" }

    override init() {
        super.init()
        hasUndoManager = false   // undo stays WebKit's own; cannot touch the change count
    }

    override class var autosavesInPlace: Bool { false }

    override func read(from data: Data, ofType typeName: String) throws {
        var body = data
        hadBOM = data.starts(with: [0xEF, 0xBB, 0xBF])
        if hadBOM { body = data.dropFirst(3) }
        guard let s = String(data: body, encoding: .utf8) else {
            throw NSError(domain: "MarkdownStudio", code: 1, userInfo: [NSLocalizedDescriptionKey: "not UTF-8 text"])
        }
        // Same rule as native.load in app.js: a NUL in the first 4096 UTF-16 units of the text.
        // (Selftest-only escape hatch so the load-failure path can be exercised end to end.)
        let forceLoadFail = selfTestPaths != nil && ProcessInfo.processInfo.environment["MDSTUDIO_TEST_SKIP_NUL_CHECK"] != nil
        if !forceLoadFail, s.utf16.prefix(4096).contains(0) {
            throw NSError(domain: "MarkdownStudio", code: 2, userInfo: [NSLocalizedDescriptionKey: "binary file (contains NUL)"])
        }
        lineEnding = Document.dominantLineEnding(s)
        text = s.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
        loadBlockedReason = nil
        windowController?.pushLoad()
    }

    static func dominantLineEnding(_ s: String) -> String {
        var crlf = 0, cr = 0, lf = 0
        var prevCR = false
        for u in s.utf8 {
            if u == 0x0A { if prevCR { crlf += 1; cr -= 1 } else { lf += 1 } }
            else if u == 0x0D { cr += 1 }
            prevCR = (u == 0x0D)
        }
        if crlf > lf && crlf >= cr { return "\r\n" }
        if cr > lf && cr > crlf { return "\r" }
        return "\n"
    }

    override func data(ofType typeName: String) throws -> Data {
        if loadBlockedReason != nil { throw Document.notLoadedError() }
        var out = lineEnding == "\n" ? text : text.replacingOccurrences(of: "\n", with: lineEnding)
        if hadBOM { out = "\u{FEFF}" + out }
        return Data(out.utf8)
    }

    override func makeWindowControllers() {
        addWindowController(DocumentWindowController(document: self))
    }

    override func save(to url: URL, ofType typeName: String, for saveOperation: NSDocument.SaveOperationType,
                       completionHandler: @escaping (Error?) -> Void) {
        if loadBlockedReason != nil { completionHandler(Document.notLoadedError()); return }
        guard let wc = windowController else {
            super.save(to: url, ofType: typeName, for: saveOperation, completionHandler: completionHandler)
            return
        }
        // completionHandler must run exactly once, whatever happens to the page or the window.
        var finished = false
        var writing = false   // once the disk write began, the timeout must not preempt it
        let finish: (Error?) -> Void = { error in
            guard !finished else { return }
            finished = true
            completionHandler(error)
        }
        func fail(_ why: String) {
            finish(NSError(domain: "MarkdownStudio", code: 4, userInfo: [NSLocalizedDescriptionKey: why]))
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
            if writing { return }
            fail("The editor did not answer in time, so nothing was saved.")
        }
        wc.fetchText { [weak self] result in
            guard !finished else { return }   // timed out already: write nothing late
            guard let self = self else { fail("The document was closed before it could be saved."); return }
            switch result {
            case .failure(let err):
                finish(err)   // nothing written
            case .success(let t):
                if self.loadBlockedReason != nil { finish(Document.notLoadedError()); return }
                self.text = t
                writing = true
                self.superSave(to: url, ofType: typeName, for: saveOperation) { error in
                    if error == nil {
                        let name = saveOperation == .saveToOperation ? self.pageName : url.lastPathComponent
                        wc.markSaved(name: name)
                    }
                    finish(error)
                }
            }
        }
    }

    private func superSave(to url: URL, ofType typeName: String, for op: NSDocument.SaveOperationType,
                           completion: @escaping (Error?) -> Void) {
        super.save(to: url, ofType: typeName, for: op, completionHandler: completion)
    }

    override func printDocument(_ sender: Any?) {
        guard let wc = windowController, let window = wc.window else { return }
        let op = wc.webView.printOperation(with: printInfo)
        op.view?.frame = wc.webView.bounds
        op.runModal(for: window, delegate: nil, didRun: nil, contextInfo: nil)
    }
}
