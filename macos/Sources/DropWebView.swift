import Cocoa
import WebKit

/// Intercepts markdown/text file drops so they open as real documents.
/// Anything else (text drags inside the editor, images) goes to WebKit untouched.
final class DropWebView: WKWebView {
    static let exts: Set<String> = ["md", "markdown", "mdown", "mkd", "txt"]

    private func droppedFiles(_ sender: NSDraggingInfo) -> [URL] {
        let urls = sender.draggingPasteboard.readObjects(
            forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? []
        return urls.filter { Self.exts.contains($0.pathExtension.lowercased()) }
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        droppedFiles(sender).isEmpty ? super.draggingEntered(sender) : .copy
    }

    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        droppedFiles(sender).isEmpty ? super.draggingUpdated(sender) : .copy
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        let files = droppedFiles(sender)
        if files.isEmpty { return super.performDragOperation(sender) }
        for url in files {
            NSDocumentController.shared.openDocument(withContentsOf: url, display: true) { _, _, error in
                if let error = error { NSApp.presentError(error) }
            }
        }
        return true
    }
}
