import Cocoa

/// Shortcut ownership: every Cmd-shortcut listed here is owned by this menu.
/// app.js skips its own `mod` shortcuts when running inside the host, so a key
/// press is handled exactly once. JS keeps Tab, Shift-Tab, Enter, Esc and `?`.
enum MainMenuBuilder {
    static func build(openRecentTarget: AppDelegate) -> NSMenu {
        let main = NSMenu()
        let name = "Markdown Studio"

        func add(_ menu: NSMenu, _ title: String, _ action: Selector?, _ key: String = "",
                 _ mods: NSEvent.ModifierFlags = [.command], target: AnyObject? = nil, id: String? = nil) {
            let it = NSMenuItem(title: title, action: action, keyEquivalent: key)
            if !key.isEmpty { it.keyEquivalentModifierMask = mods }
            it.target = target
            it.representedObject = id
            menu.addItem(it)
        }
        func submenu(_ title: String) -> NSMenu {
            let item = NSMenuItem(); main.addItem(item)
            let m = NSMenu(title: title); item.submenu = m
            return m
        }
        let cmd: Selector = #selector(DocumentWindowController.mdCommand(_:))

        // App
        let app = submenu(name)
        add(app, "About \(name)", #selector(NSApplication.orderFrontStandardAboutPanel(_:)))
        app.addItem(.separator())
        add(app, "Hide \(name)", #selector(NSApplication.hide(_:)), "h")
        add(app, "Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option])
        add(app, "Show All", #selector(NSApplication.unhideAllApplications(_:)))
        app.addItem(.separator())
        add(app, "Quit \(name)", #selector(NSApplication.terminate(_:)), "q")

        // File
        let file = submenu("File")
        add(file, "New", #selector(NSDocumentController.newDocument(_:)), "n")
        add(file, "Open…", #selector(NSDocumentController.openDocument(_:)), "o")
        let recentItem = NSMenuItem(title: "Open Recent", action: nil, keyEquivalent: "")
        let recent = NSMenu(title: "Open Recent")
        recent.delegate = RecentMenuDelegate.shared
        RecentMenuDelegate.shared.target = openRecentTarget
        recentItem.submenu = recent
        file.addItem(recentItem)
        file.addItem(.separator())
        add(file, "Close", #selector(NSWindow.performClose(_:)), "w")
        add(file, "Save…", #selector(NSDocument.save(_:)), "s")
        add(file, "Save As…", #selector(NSDocument.saveAs(_:)), "s", [.command, .shift])
        file.addItem(.separator())
        add(file, "Print…", #selector(NSDocument.printDocument(_:)), "p")

        // Edit
        let edit = submenu("Edit")
        add(edit, "Undo", #selector(DocumentWindowController.mdUndo(_:)), "z")
        add(edit, "Redo", #selector(DocumentWindowController.mdRedo(_:)), "z", [.command, .shift])
        edit.addItem(.separator())
        add(edit, "Cut", #selector(NSText.cut(_:)), "x")
        add(edit, "Copy", #selector(NSText.copy(_:)), "c")
        add(edit, "Paste", #selector(NSText.paste(_:)), "v")
        add(edit, "Delete", #selector(NSText.delete(_:)))
        add(edit, "Select All", #selector(NSText.selectAll(_:)), "a")
        edit.addItem(.separator())
        add(edit, "Find in Page…", #selector(DocumentWindowController.mdFind(_:)), "f")
        add(edit, "Find Next", #selector(DocumentWindowController.mdFindNext(_:)), "g")
        add(edit, "Find Previous", #selector(DocumentWindowController.mdFindPrevious(_:)), "g", [.command, .shift])
        edit.addItem(.separator())
        add(edit, "Copy Rendered HTML", cmd, "c", [.command, .option], id: "copy-html")

        // Format
        let fmt = submenu("Format")
        add(fmt, "Bold", cmd, "b", id: "bold")
        add(fmt, "Italic", cmd, "i", id: "italic")
        add(fmt, "Link", cmd, "k", id: "link")

        // View
        let view = submenu("View")
        add(view, "Editor Only", cmd, "1", id: "mode-edit")
        add(view, "Split", cmd, "2", id: "mode-split")
        add(view, "Reader Only", cmd, "3", id: "mode-read")
        view.addItem(.separator())
        add(view, "Cycle View Mode", cmd, "\\", id: "mode-cycle")
        add(view, "Toggle Outline", cmd, "o", [.command, .shift], id: "outline")
        add(view, "Cycle Theme", cmd, "/", id: "theme-cycle")

        // Window
        let win = submenu("Window")
        add(win, "Minimize", #selector(NSWindow.performMiniaturize(_:)), "m")
        add(win, "Zoom", #selector(NSWindow.performZoom(_:)))
        win.addItem(.separator())
        add(win, "Bring All to Front", #selector(NSApplication.arrangeInFront(_:)))
        NSApp.windowsMenu = win

        // Help
        let help = submenu("Help")
        add(help, "Keyboard Shortcuts", cmd, id: "help")
        add(help, "Open Demo Document", #selector(AppDelegate.openDemo(_:)), target: openRecentTarget)
        NSApp.helpMenu = help
        return main
    }
}

final class RecentMenuDelegate: NSObject, NSMenuDelegate {
    static let shared = RecentMenuDelegate()
    weak var target: AppDelegate?

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        for url in NSDocumentController.shared.recentDocumentURLs {
            let it = NSMenuItem(title: url.lastPathComponent, action: #selector(AppDelegate.openRecent(_:)), keyEquivalent: "")
            it.target = target
            it.representedObject = url
            menu.addItem(it)
        }
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Clear Menu", action: #selector(NSDocumentController.clearRecentDocuments(_:)), keyEquivalent: ""))
    }
}
