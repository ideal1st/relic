pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.worker.min.js';

let books = [];
let activeBookId = null;
let db;
let currentURL = null;
let recentFolders = [];
let cbzUrls = []; 
let currentRendition; 
let currentView = 'grid'; 

// --- VIEW MODE-SWITCHING TOGGLE ---
function setView(viewType) {
    currentView = viewType;
    // Toggle active button states
    document.getElementById('view-grid').classList.toggle('active', viewType === 'grid');
    document.getElementById('view-list').classList.toggle('active', viewType === 'list');
    renderGrid();
}

// --- DYNAMIC TRACKING OBSERVER ---
// Monitors which page/image is in the viewport for PDF and CBZ[cite: 2]
const observerOptions = {
    root: null, 
    threshold: 0.5 
};

const pageObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            const b = books.find(x => x.id === activeBookId);
            if (!b) return;

            const pageNum = entry.target.dataset.page;
            const locInput = document.getElementById('note-location');
            const cfiInput = document.getElementById('note-cfi');

            if (b.type === 'cbz') {
                locInput.value = `Img ${pageNum}`;
                cfiInput.value = pageNum;
            } else if (b.type === 'pdf') {
                locInput.value = `Page ${pageNum}`;
                cfiInput.value = pageNum;
            }
        }
    });
}, observerOptions);

// --- DATABASE CORE ---
const request = indexedDB.open("LibraryCache", 4);
request.onupgradeneeded = e => {
    const d = e.target.result;
    if (!d.objectStoreNames.contains("books")) d.createObjectStore("books", { keyPath: "name" });
    if (!d.objectStoreNames.contains("folders")) d.createObjectStore("folders", { keyPath: "name" });
};
request.onsuccess = e => { db = e.target.result; loadRecentFolders(); };

// --- FOLDER MANAGEMENT ---
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
                let pageCount = stored ? (stored.pages || 0) : 0;
/*                if (ext === 'pdf') {
                    try {
                        const pdfData = await file.arrayBuffer();
                        const pdf = await pdfjsLib.getDocument({data: pdfData}).promise;
                        pageCount = pdf.numPages;
                    } catch (e) {}
                }*/
                if (pageCount === 0) {
                    try {
                        if (ext === 'pdf') {
                            const pdfData = await file.arrayBuffer();
                            const pdf = await pdfjsLib.getDocument({data: pdfData}).promise;
                            pageCount = pdf.numPages;
                        } 
                        else if (ext === 'cbz') {
                            const zip = await JSZip.loadAsync(file);
                            pageCount = Object.keys(zip.files).filter(name => 
                                /\.(jpg|jpeg|png|webp)$/i.test(name)
                            ).length;
                        } 
                        else if (ext === 'epub') {
                            // Initialize the book in memory to count locations
                            const book = ePub(file);
                            // Generate locations based on your 1800-character rule
                            await book.ready;
                            const locations = await book.locations.generate(1800);
                            pageCount = locations.length;
                            // Clean up the book object from memory
                            book.destroy();
                        }
                        // SAVE to IndexedDB immediately after calculation
                        saveBookData(file.name, { pages: pageCount });
                    } catch (e) {
                        console.warn(`Failed to count pages for ${file.name}:`, e);
                    }
                }
                books.push({
                    id: Math.random().toString(36).substr(2, 9),
                    name: file.name, blob: file, size: file.size, date: file.lastModified, type: ext,
                    pages: pageCount, lastAccessed: new Date().toLocaleString(),
                    cover: stored ? stored.cover : null, tags: stored ? (stored.tags || []) : [], notes: stored ? (stored.notes || []) : []
                });
                renderGrid();
                if (!stored?.cover) {
                    if (ext === 'pdf') generatePDFCover(file, file.name);
                    else if (ext === 'epub') generateEPUBCover(file, file.name);
                    else if (ext === 'cbz') generateCBZCover(file, file.name);
                }
            }
        }
    }
}

// --- RENDER ENGINES ---

/*async function renderPDFMobile(blob, pageNum = 1) {
    const canvas = document.getElementById('pdf-canvas');
    const context = canvas.getContext('2d');
    context.clearRect(0, 0, canvas.width, canvas.height);
    const url = URL.createObjectURL(blob);
    const pdf = await pdfjsLib.getDocument(url).promise;
    const page = await pdf.getPage(pageNum);
    
    document.getElementById('note-location').value = `Page ${pageNum}`;
    document.getElementById('note-cfi').value = pageNum;

    const viewport = page.getViewport({ scale: 1.5 });
    canvas.height = viewport.height; canvas.width = viewport.width;
    await page.render({ canvasContext: context, viewport: viewport }).promise;
    URL.revokeObjectURL(url);
}*/

function renderEPUB(blob) {
    if (typeof ePub === 'undefined') return;
    const container = document.getElementById('epub-viewer');
    const controls = document.getElementById('epub-controls');
    container.innerHTML = '';
    const book = ePub(blob);
    currentRendition = book.renderTo("epub-viewer", { width: "100%", height: "100%", flow: "scrolled-doc" });
    // When the rendition is attached and displayed, dim the controls
    currentRendition.display().then(() => {
        controls.classList.add('dimmed');
    });
    // Optional: If the viewer's clicked, ensure it dims again
    currentRendition.on("click", () => {
        controls.classList.add('dimmed');
    });    
    book.ready.then(() => book.locations.generate(1800)).then(() => updateProgress(book));
    
    currentRendition.on("relocated", (location) => {
        const percent = Math.floor(book.locations.percentageFromCfi(location.start.cfi) * 100);
        document.getElementById('note-location').value = percent + "%";
        document.getElementById('note-cfi').value = location.start.cfi;
        updateProgress(book);
    });
    currentRendition.display();
}
function seekEpub(value) {
    if (currentRendition && currentRendition.book.locations) {
        const percentage = value / 100;
        const cfi = currentRendition.book.locations.cfiFromPercentage(percentage);
        currentRendition.display(cfi);
    }
}

async function renderCBZ(blob) {
    const container = document.getElementById('cbz-viewer');
    container.innerHTML = '';
    cleanupCBZ();
    const zip = await JSZip.loadAsync(blob);
    const images = Object.keys(zip.files).filter(n => /\.(jpg|jpeg|png|webp)$/i.test(n)).sort();
    for (let i = 0; i < images.length; i++) {
        const imgBlob = await zip.files[images[i]].async("blob");
        const url = URL.createObjectURL(imgBlob);
        cbzUrls.push(url);
        const img = document.createElement('img');
        img.src = url;
        img.className = "img-fluid mb-2 cbz-page";
        img.dataset.page = i + 1; // Correct index for labeling[cite: 2]
        container.appendChild(img);
        pageObserver.observe(img); // Start tracking this image[cite: 2]
    }
    document.getElementById('note-location').value = `Img ${pageNum}`;
    document.getElementById('note-cfi').value = pageNum;
}

// --- READER DISPATCH ---
function openBook(id) {
    activeBookId = id; 
    const b = books.find(x => x.id === id);
    const viewers = {
        pdf: document.getElementById('pdf-viewer-frame'),
        canvas: document.getElementById('pdf-canvas'),
        epub: document.getElementById('epub-viewer'),
        cbz: document.getElementById('cbz-viewer')
    };
    
    // Reset location fields for new session[cite: 1]
    document.getElementById('note-location').value = '';
    document.getElementById('note-cfi').value = '';
    
    Object.values(viewers).forEach(el => el.style.display = 'none');
    document.getElementById('reader-overlay').style.display = 'block';
    document.getElementById('reading-title').innerText = b.name;
    document.getElementById('epub-controls').style.display = (b.type === 'epub') ? 'block' : 'none';

    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

    if (b.type === 'pdf') {
        /*if (isMobile) {
            viewers.canvas.style.display = 'block';
            renderPDFMobile(b.blob);
        } else {*/
            const fileURL = URL.createObjectURL(b.blob);
            // Path to your local PDF.js viewer
            const viewerPath = '/assets/pdfjs/web/viewer.html'; 
            viewers.pdf.src = `${viewerPath}?file=${encodeURIComponent(fileURL)}`;
            viewers.pdf.style.display = 'block';
    
            // Listen for page changes from the viewer
            viewers.pdf.onload = () => {
                const viewerApp = viewers.pdf.contentWindow.PDFViewerApplication;
                viewerApp.eventBus.on('pagechanging', (evt) => {
                    const pageNum = evt.pageNumber;
                    document.getElementById('note-location').value = `Page ${pageNum}`;
                    document.getElementById('note-cfi').value = pageNum;
                });
            };
        //}
    } else if (b.type === 'epub') {
        viewers.epub.style.display = 'block';
        renderEPUB(b.blob);
    } else if (b.type === 'cbz') {
        viewers.cbz.style.display = 'block';
        renderCBZ(b.blob);
    }
    renderNotes();
}

function closeReader() {
    document.getElementById('reader-overlay').style.display = 'none';
    document.getElementById('pdf-viewer-frame').src = '';
    // Reset EPUB controls opacity for the next session
    const controls = document.getElementById('epub-controls');
    controls.classList.remove('dimmed');
    pageObserver.disconnect(); // Stop tracking to save memory
    cleanupCBZ();
}

// --- NOTE TAKING SYSTEM ---
function renderNotes() {
    const b = books.find(x => x.id === activeBookId);
    const list = document.getElementById('notes-list');
    const query = document.getElementById('note-search').value.toLowerCase();
    if (!b || !b.notes) return;
    list.innerHTML = b.notes
        .filter(n => n.text.toLowerCase().includes(query))
        // 1. Sort by page (numeric) then by CFI value (string) for EPUBs
        .sort((a, b) => {
            if (a.page !== b.page) return a.page - b.page;
            return String(a.value).localeCompare(String(b.value), undefined, { numeric: true });
        })
        .map((n) => {
            // 2. Find actual index for the delete button to avoid index-shifting bugs
            const originalIndex = b.notes.findIndex(note => note === n);
        let highlightedText = n.text;
        if (query) {
            const regex = new RegExp(`(${query})`, 'gi');
            highlightedText = n.text.replace(regex, '<mark>$1</mark>');
        }
        // Dynamic labels based on file type[cite: 3]
        let label = (b.type === 'cbz') ? `Img ${n.page}` : (b.type === 'pdf') ? `Page ${n.page}` : `${n.page}`;
        if (b.type === 'epub') label = n.display || `${n.page}%`;

        return `
            <div class="mb-3 p-2 border rounded bg-light small position-relative">
                <span class="badge bg-primary cursor-pointer mb-2" onclick="jumpToLocation('${n.value || n.page}')">
                    ${label}
                </span>
                <div class="text-dark">${n.text}</div>
                <button class="btn btn-xs btn-link text-danger p-0" style="position:absolute; top:2px; right:8px" onclick="deleteNote(${originalIndex})">&times;</button>
            </div>
        `;
    }).join('');
}

async function addNote() {
    const b = books.find(x => x.id === activeBookId);
    const locLabel = document.getElementById('note-location').value;
    const locValue = document.getElementById('note-cfi').value;
    const text = document.getElementById('note-text').value;

    if (text) {
        // Store only the integer for page tracking to keep DB clean
        const pageNum = (b.type === 'epub') ? 0 : parseInt(locValue);
        
        b.notes.push({ 
            page: pageNum, 
            value: locValue, 
            display: locLabel, 
            text: text 
        });
        
        await saveBookData(b.name, { notes: b.notes });
        document.getElementById('note-text').value = '';
        renderNotes();
    }
}

async function jumpToLocation(val) {
    const b = books.find(x => x.id === activeBookId);
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    if (b.type === 'epub' && currentRendition) {
        currentRendition.display(val);
    } else if (b.type === 'pdf') {
        /*if (isMobile) {
            renderPDFMobile(b.blob, parseInt(val));
        } else {*/
            const viewerFrame = document.getElementById('pdf-viewer-frame');
            const viewerApp = viewerFrame.contentWindow.PDFViewerApplication;
            if (viewerApp) viewerApp.page = parseInt(val);
        //}
    } else if (b.type === 'cbz') {
        const imgs = document.querySelectorAll('.cbz-page');
        if (imgs[parseInt(val)-1]) imgs[parseInt(val)-1].scrollIntoView({ behavior: 'smooth' });
    }
}

// --- SUPPORT FUNCTIONS ---
async function getStoredBookData(name) {
    return new Promise(r => {
        const trans = db.transaction("books", "readonly");
        const req = trans.objectStore("books").get(name);
        req.onsuccess = () => r(req.result || null);
    });
}

async function saveBookData(name, newData) {
    const existing = await getStoredBookData(name) || { name, tags: [], cover: null, notes: [], pageCount: 0 };
    const updated = { ...existing, ...newData };
    const trans = db.transaction("books", "readwrite");
    trans.objectStore("books").put(updated);
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
    } catch (e) {
        console.error("PDF Cover error:", e);
    }
}

async function generateEPUBCover(file, fileName) {
    try {
        const book = ePub(file);
        const coverUrl = await book.coverUrl();
        
        if (coverUrl) {
            // Convert URL to DataURL for permanent storage in IndexedDB
            const response = await fetch(coverUrl);
            const blob = await response.blob();
            const reader = new FileReader();
            reader.onloadend = () => {
                const cover = reader.result;
                const book = books.find(b => b.name === fileName);
                if (book) { book.cover = cover; renderGrid(); }
                saveBookData(fileName, { cover });
            };
            reader.readAsDataURL(blob);
        }
    } catch (e) {
        console.error("EPUB Cover error:", e);
    }
}

async function generateCBZCover(file, fileName) {
    try {
        const zip = await JSZip.loadAsync(file);
        // Find the first image file alphabetically
        const imageFile = Object.keys(zip.files)
            .filter(name => /\.(jpg|jpeg|png|webp)$/i.test(name))
            .sort()[0];

        if (imageFile) {
            const blob = await zip.files[imageFile].async("blob");
            const reader = new FileReader();
            reader.onloadend = () => {
                const cover = reader.result;
                const book = books.find(b => b.name === fileName);
                if (book) { book.cover = cover; renderGrid(); }
                saveBookData(fileName, { cover });
            };
            reader.readAsDataURL(blob);
        }
    } catch (e) {
        console.error("CBZ Cover error:", e);
    }
}

function cleanupCBZ() { cbzUrls.forEach(url => URL.revokeObjectURL(url)); cbzUrls = []; }

function updateProgress(book) {
    if (book.locations.length() > 0 && currentRendition.location) {
        const percent = Math.floor(book.locations.percentageFromCfi(currentRendition.location.start.cfi) * 100);
        const slider = document.getElementById('epub-slider');
        if(slider) slider.value = percent;
        document.getElementById('epub-percent').innerText = percent + "%";
    }
}
function prevPage() { if (currentRendition) currentRendition.prev(); }
function nextPage() { if (currentRendition) currentRendition.next(); }
async function deleteNote(i) { const b = books.find(x => x.id === activeBookId); b.notes.splice(i, 1); await saveBookData(b.name, { notes: b.notes }); renderNotes(); }

async function addTag(id) { const b = books.find(x => x.id === id); const t = prompt("Label name:"); if (t) { b.tags.push(t); await saveBookData(b.name, { tags: b.tags }); renderGrid(); } }
async function removeTagByIndex(id, i) { const b = books.find(x => x.id === id); b.tags.splice(i, 1); await saveBookData(b.name, { tags: b.tags }); renderGrid(); }


// --- UI AND GRID LOGIC ---
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
    
/*    grid.className = currentView === 'list' ? "row row-cols-1 g-2" : "row row-cols-1 row-cols-sm-2 row-cols-md-4 row-cols-lg-5 g-4";
    grid.innerHTML = filtered.map(b => {
        if (currentView === 'list') {
            return `<div class="col"><div class="book-peek p-2 d-flex align-items-center gap-3 shadow-sm" onclick="openBook('${b.id}')"><div style="width: 40px; height: 50px; flex-shrink: 0;">${b.cover ? `<img src="${b.cover}" class="cover-img rounded">` : `<i data-lucide="file-text"></i>`}</div><div class="flex-grow-1"><div class="fw-bold small">${b.name}</div><div class="text-muted" style="font-size: 0.7rem;">${b.type.toUpperCase()} • ${b.pages} Pages</div></div></div></div>`;
        } else {
            return `
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
            </div>`;
        }
    }).join('');*/
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

// --- DANGEROUS BUT IMPORTANT STUFF ---
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