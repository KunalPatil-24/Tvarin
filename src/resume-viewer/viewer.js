const RESUME_KEY = "tvarin.resume";

function formatSize(bytes) {
  if (!bytes && bytes !== 0) return "";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

chrome.storage.local.get(RESUME_KEY, (res) => {
  const resume = res[RESUME_KEY];
  const content = document.getElementById("content");
  if (!resume || !resume.dataUrl) {
    content.innerHTML = `<div class="empty">No resume saved yet.</div>`;
    return;
  }

  document.getElementById("name").textContent = resume.name || "Resume";
  document.getElementById("meta").textContent = formatSize(resume.size);

  const isPdf =
    (resume.type && resume.type.includes("pdf")) ||
    /\.pdf$/i.test(resume.name || "");

  if (isPdf) {
    const frame = document.createElement("iframe");
    frame.title = resume.name || "Resume";
    frame.src = resume.dataUrl;
    content.appendChild(frame);
  } else {
    content.innerHTML = `
      <div class="empty">
        <p>Preview isn’t available for this file type in the browser.</p>
        <a class="dl" id="download" download="${resume.name || "resume"}">Download resume</a>
      </div>`;
    document.getElementById("download").href = resume.dataUrl;
  }
});
