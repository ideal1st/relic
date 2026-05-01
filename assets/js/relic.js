pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.worker.min.js';

let books = [];
let activeBookId = null;
let db;
let currentURL = null;
let recentFolders = [];
let currentView = 'grid'; // Default state

function setView(viewType) {
    currentView = viewType;
    // Toggle active button states
    document.getElementById('view-grid').classList.toggle('active', viewType === 'grid');
    document.getElementById('view-list').classList.toggle('active', viewType === 'list');
    renderGrid();
}

const request = indexedDB.open("LibraryCache", 4);
request.onupgradeneeded = e => {
    const d = e.target.result;
    if (!d.objectStoreNames.contains("books")) d.createObjectStore("books", { keyPath: "name" });
    if (!d.objectStoreNames.contains("folders")) d.createObjectStore("folders", { keyPath: "name" });
};
request.onsuccess = e => { db = e.target.result; loadRecentFolders(); };

async function loadRecentFolders() {
    const trans = db.transaction("folders", "readonly");
    const req = trans.objectStore("folders").getAll();
    req.onsuccess = () => { recentFolders = req.result || []; renderFolderList(); };
}

async function saveFolderToDB(folderObj) {
    const trans = db.transaction("folders", "readwrite");
    trans.objectStore("folders").put(folderObj);
}

function toggleDrawer() {
    document.getElementById('drawer').classList.toggle('open');
    document.getElementById('drawer-overlay').classList.toggle('open');
}

function renderFolderList() {
    const list = document.getElementById('folder-list');
    if (recentFolders.length === 0) { list.innerHTML = '<p class="text-muted small text-center mt-3">Empty history.</p>'; return; }
    list.innerHTML = recentFolders.sort((a,b) => b.pinned - a.pinned || b.lastOpened - a.lastOpened).slice(0, 10).map((f, i) => `
        <div class="folder-item">
            <div class="text-truncate flex-grow-1 small fw-bold" onclick="reconnectFolder('${f.name}')">
                <i data-lucide="folder" class="me-2 text-warning" style="width:14px"></i> ${f.name}
            </div>
            <i data-lucide="pin" class="${f.pinned ? 'pinned-icon' : 'text-muted'}" style="width:16px; cursor:pointer" onclick="togglePin('${f.name}')"></i>
        </div>
    `).join('');
    lucide.createIcons();
}

async function togglePin(name) {
    const f = recentFolders.find(x => x.name === name);
    f.pinned = !f.pinned;
    await saveFolderToDB(f);
    renderFolderList();
}

async function initLibrary() { try { const handle = await window.showDirectoryPicker(); processFolder(handle); } catch (e) {} }

async function reconnectFolder(name) {
    const folder = recentFolders.find(f => f.name === name);
    try {
        if (await folder.handle.requestPermission({ mode: 'read' }) === 'granted') {
            processFolder(folder.handle);
            toggleDrawer();
        }
    } catch (e) {
        const handle = await window.showDirectoryPicker();
        processFolder(handle);
    }
}

async function processFolder(handle) {
    const folderData = { name: handle.name, handle: handle, lastOpened: Date.now(), pinned: false };
    const existing = recentFolders.find(f => f.name === handle.name);
    if (existing) folderData.pinned = existing.pinned;
    await saveFolderToDB(folderData);
    loadRecentFolders();
    books = [];
    document.getElementById('grid').innerHTML = '<div class="text-center w-100 py-5"><div class="spinner-border text-primary"></div><p class="mt-2">Indexing files...</p></div>';
    for await (const entry of handle.values()) {
        if (entry.kind === 'file') {
            const file = await entry.getFile();
            const ext = file.name.split('.').pop().toLowerCase();
            if (['pdf', 'epub', 'cbz'].includes(ext)) {
                const stored = await getStoredBookData(file.name);
                let pageCount = 0;
                // ONLY run the PDF-specific logic if the file is a PDF
                    if (ext === 'pdf') {
                        try {
                            const pdfData = await file.arrayBuffer();
                            const pdf = await pdfjsLib.getDocument({data: pdfData}).promise;
                            pageCount = pdf.numPages;
                        } catch (e) {
                            console.warn("Skipping page count for:", file.name);
                        }
                    }
                    books.push({
                    id: Math.random().toString(36).substr(2, 9),
                    name: file.name, blob: file, size: file.size, date: file.lastModified, type: ext,
                    pages: pageCount, lastAccessed: new Date().toLocaleString(),
                    cover: stored ? stored.cover : null, tags: stored ? (stored.tags || []) : [], notes: stored ? (stored.notes || []) : []
                });
                renderGrid();
                if (!stored?.cover && ext === 'pdf') generatePDFCover(file, file.name);
            }
        }
    }
}

async function getStoredBookData(name) {
    return new Promise(r => {
        const trans = db.transaction("books", "readonly");
        const req = trans.objectStore("books").get(name);
        req.onsuccess = () => r(req.result || null);
    });
}

async function saveBookData(name, newData) {
    const existing = await getStoredBookData(name) || { name, tags: [], cover: null, notes: [] };
    const updated = { ...existing, ...newData };
    db.transaction("books", "readwrite").objectStore("books").put(updated);
}

async function generatePDFCover(file, fileName) {
    try {
        const arrayBuffer = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({data: arrayBuffer}).promise;
        const page = await pdf.getPage(1);
        const canvas = document.createElement('canvas');
        const viewport = page.getViewport({scale: 0.3});
        canvas.height = viewport.height; canvas.width = viewport.width;
        await page.render({canvasContext: canvas.getContext('2d'), viewport}).promise;
        const cover = canvas.toDataURL();
        const book = books.find(b => b.name === fileName);
        if(book) { book.cover = cover; renderGrid(); }
        saveBookData(fileName, { cover });
    } catch (e) {}
}

function renderGrid() {
    const grid = document.getElementById('grid');
    const s = document.getElementById('search').value.toLowerCase();
    const sortVal = document.getElementById('sort').value;
    let filtered = books.filter(b => b.name.toLowerCase().includes(s) || b.tags.some(t => t.toLowerCase().includes(s)) || b.notes.some(n => n.text.toLowerCase().includes(s)));
    filtered.sort((a, b) => {
        if (sortVal === 'size') return b.size - a.size;
        if (sortVal === 'date') return b.date - a.date;
        if (sortVal === 'type') return a.type.localeCompare(b.type); // Sort by extension
        if (sortVal === 'pages') return b.pages - a.pages; // Sort by page count
        return a.name.localeCompare(b.name);
    });
    if (currentView === 'list') {
        // List View: One column, horizontal layout
        grid.className = "row row-cols-1 g-2"; 
        grid.innerHTML = filtered.map(b => `
            <div class="col">
                <div class="book-peek p-2 d-flex align-items-center gap-3 shadow-sm" onclick="openBook('${b.id}')">
                    <div style="width: 40px; height: 50px; flex-shrink: 0;">
                        ${b.cover ? `<img src="${b.cover}" class="cover-img rounded">` : `<i data-lucide="file-text"></i>`}
                    </div>
                    <div class="flex-grow-1">
                        <div class="fw-bold small">${b.name}</div>
                        <div class="text-muted" style="font-size: 0.7rem;">
                            ${b.type.toUpperCase()} • ${(b.size / 1024).toFixed(1)} KB • ${b.pages} Pages
                        </div>
                        <div>${b.tags.map((t, i) => `<span class="tag-pill">${t}<span class="tag-remove" onclick="event.stopPropagation(); removeTagByIndex('${b.id}', ${i})">&times;</span></span>`).join('')}</div>
                    </div>
                    <div class="text-muted small">Accessed: ${b.lastAccessed || 'N/A'}</div>
                </div>
            </div>
        `).join('');
    } else {
        // Grid View: Original multi-column layout
        grid.className = "row row-cols-1 row-cols-sm-2 row-cols-md-4 row-cols-lg-5 g-4";
        grid.innerHTML = filtered.map(b => `
            <div class="col">
                <div class="book-card shadow-sm">
                    <div class="cover-box" onclick="openBook('${b.id}')">
                        ${b.cover ? `<img src="${b.cover}" class="cover-img">` : `<i data-lucide="book" style="color:#bdc3c7"></i>`}
                    </div>
                    <div class="p-2 flex-grow-1">
                        <div class="fw-bold text-truncate small mb-1" title="${b.name}">${b.name}</div>
                        <div>${b.tags.map((t, i) => `<span class="tag-pill">${t}<span class="tag-remove" onclick="event.stopPropagation(); removeTagByIndex('${b.id}', ${i})">&times;</span></span>`).join('')}</div>
                    </div>
                    <div class="p-2 border-top text-center"><button class="btn btn-link btn-sm p-0 text-decoration-none" onclick="addTag('${b.id}')">+ Label</button></div>
                </div>
            </div>
        `).join('');
    }
    lucide.createIcons();
}

function openBook(id) {
    activeBookId = id; const b = books.find(x => x.id === id);
    if(currentURL) URL.revokeObjectURL(currentURL);
    currentURL = URL.createObjectURL(b.blob);
    document.getElementById('reading-title').innerText = b.name;
    document.getElementById('viewer').src = currentURL;
    document.getElementById('reader-overlay').style.display = 'block';
    document.getElementById('note-search').value = ''; // Reset note search
    renderNotes();
}

// --- REFINED RENDER NOTES WITH SEARCH & HIGHLIGHT ---
function renderNotes() {
    const b = books.find(x => x.id === activeBookId);
    const list = document.getElementById('notes-list');
    const query = document.getElementById('note-search').value.toLowerCase();

    // Filter based on Sidebar Search
    const filteredNotes = b.notes.filter(n => n.text.toLowerCase().includes(query));

    list.innerHTML = filteredNotes.sort((a,b) => a.page - b.page).map((n, i) => {
        let highlightedText = n.text;
        if (query) {
            const regex = new RegExp(`(${query})`, 'gi');
            highlightedText = n.text.replace(regex, '<mark>$1</mark>');
        }

        return `
            <div class="mb-2 p-2 border rounded bg-light small position-relative">
                <span class="badge bg-primary cursor-pointer mb-1" onclick="jumpToPage(${n.page})">Page ${n.page}</span>
                <div>${highlightedText}</div>
                <button class="btn btn-xs btn-link text-danger p-0" style="position:absolute; top:2px; right:5px" onclick="deleteNote(${i})">&times;</button>
            </div>
        `;
    }).join('');
}

async function addNote() {
    const b = books.find(x => x.id === activeBookId);
    const pageEl = document.getElementById('note-page');
    const textEl = document.getElementById('note-text');
    const page = parseInt(pageEl.value) || 1;
    const text = textEl.value;
    
    if (text) { 
        b.notes.push({ page, text }); 
        await saveBookData(b.name, { notes: b.notes }); 
        textEl.value = ''; 
        textEl.focus(); // Keep focus for faster note taking
        renderNotes(); 
    }
}

async function deleteNote(i) {
    const b = books.find(x => x.id === activeBookId);
    b.notes.splice(i, 1); await saveBookData(b.name, { notes: b.notes }); renderNotes();
}

function jumpToPage(p) { const v = document.getElementById('viewer'); v.src = v.src.split('#')[0] + '#page=' + p; }
async function addTag(id) { const b = books.find(x => x.id === id); const t = prompt("Label name:"); if (t) { b.tags.push(t); await saveBookData(b.name, { tags: b.tags }); renderGrid(); } }
async function removeTagByIndex(id, i) { const b = books.find(x => x.id === id); b.tags.splice(i, 1); await saveBookData(b.name, { tags: b.tags }); renderGrid(); }
function closeReader() { document.getElementById('reader-overlay').style.display = 'none'; document.getElementById('viewer').src = ''; }

async function exportData() {
    const trans = db.transaction(["books", "folders"], "readonly");
    const bData = await new Promise(r => trans.objectStore("books").getAll().onsuccess = e => r(e.target.result));
    const fData = await new Promise(r => trans.objectStore("folders").getAll().onsuccess = e => r(e.target.result));
    const blob = new Blob([JSON.stringify({ books: bData, folders: fData.map(f => ({...f, handle: null})) })], { type: "application/json" });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `relic_backup_${new Date().toISOString().split('T')[0]}.json`;
    a.click();
}

function triggerImport() { document.getElementById('import-file').click(); }
async function importData(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
        try {
            const data = JSON.parse(ev.target.result);
            const trans = db.transaction(["books", "folders"], "readwrite");
            data.books.forEach(b => trans.objectStore("books").put(b));
            data.folders.forEach(f => trans.objectStore("folders").put(f));
            trans.oncomplete = () => {
                alert ("Import successful! Please re-open your folders to re-authorize file access.");
                location.reload();
            };
        } catch (err) {
            alert ("Invalid backup file.");
        }
    };
    reader.readAsText(file);
}
function clearCache() { if(confirm("Clear data?")) { indexedDB.deleteDatabase("LibraryCache"); location.reload(); } }