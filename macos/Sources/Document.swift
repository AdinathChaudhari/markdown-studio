import Cocoa
import WebKit

@objc(MDDocument)
final class Document: NSDocument {
    /// Last text known to native: what was read from disk, or what getText returned for a save.
    var text = ""
    var keepWhenOpeningFiles = false

    var windowController: DocumentWindowController? { windowControllers.first as? DocumentWindowController }
    var pageName: String { fileURL?.lastPathComponent ?? "Untitled" }

    override init() {
        super.init()
        hasUndoManager = false   // undo stays WebKit's own; cannot touch the change count
    }

    override class var autosavesInPlace: Bool { false }

    override func read(from data: Data, ofType typeName: String) throws {
        guard let s = String(data: data, encoding: .utf8) else {
            throw NSError(domain: "MarkdownStudio", code: 1, userInfo: [NSLocalizedDescriptionKey: "not UTF-8 text"])
        }
        if data.prefix(4096).contains(0) {
            throw NSError(domain: "MarkdownStudio", code: 2, userInfo: [NSLocalizedDescriptionKey: "binary file (contains NUL)"])
        }
        text = s.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
        windowController?.pushLoad()
    }

    override func data(ofType typeName: String) throws -> Data { Data(text.utf8) }

    override func makeWindowControllers() {
        addWindowController(DocumentWindowController(document: self))
    }

    override func save(to url: URL, ofType typeName: String, for saveOperation: NSDocument.SaveOperationType,
                       completionHandler: @escaping (Error?) -> Void) {
        guard let wc = windowController else {
            super.save(to: url, ofType: typeName, for: saveOperation, completionHandler: completionHandler)
            return
        }
        wc.fetchText { [weak self] result in
            guard let self = self else { return }
            switch result {
            case .failure(let err):
                completionHandler(err)   // nothing written
            case .success(let t):
                self.text = t
                self.superSave(to: url, ofType: typeName, for: saveOperation) { error in
                    if error == nil {
                        let name = saveOperation == .saveToOperation ? self.pageName : url.lastPathComponent
                        wc.markSaved(name: name)
                    }
                    completionHandler(error)
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
