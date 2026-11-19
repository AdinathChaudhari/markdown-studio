import Cocoa

final class DocumentController: NSDocumentController {
    /// A modal NSAlert blocks the main run loop, so in selftest never show one: log and move on.
    override func presentError(_ error: Error) -> Bool {
        if selfTestPaths != nil {
            FileHandle.standardError.write(Data("selftest suppressed error dialog: \(error)\n".utf8))
            return true
        }
        return super.presentError(error)
    }
    override func presentError(_ error: Error, modalFor window: NSWindow, delegate: Any?,
                               didPresent: Selector?, contextInfo: UnsafeMutableRawPointer?) {
        if selfTestPaths != nil {
            FileHandle.standardError.write(Data("selftest suppressed error sheet: \(error)\n".utf8))
            return
        }
        super.presentError(error, modalFor: window, delegate: delegate, didPresent: didPresent, contextInfo: contextInfo)
    }

    override func openDocument(withContentsOf url: URL, display displayDocument: Bool,
                               completionHandler: @escaping (NSDocument?, Bool, Error?) -> Void) {
        super.openDocument(withContentsOf: url, display: displayDocument) { [weak self] doc, wasOpen, error in
            if let self = self, let opened = doc, error == nil {
                for other in self.documents where other !== opened {
                    if let d = other as? Document, d.fileURL == nil, !d.isDocumentEdited,
                       d.text.isEmpty, !d.keepWhenOpeningFiles {
                        d.close()
                    }
                }
            }
            completionHandler(doc, wasOpen, error)
        }
    }
}
