(function () {
  'use strict';

  const Capacitor = window.Capacitor;
  if (!Capacitor || typeof Capacitor.isNativePlatform !== 'function' || !Capacitor.isNativePlatform()) return;

  const FilePicker = typeof Capacitor.registerPlugin === 'function'
    ? Capacitor.registerPlugin('FilePicker')
    : Capacitor.Plugins && Capacitor.Plugins.FilePicker;
  const SystemFileSaver = typeof Capacitor.registerPlugin === 'function'
    ? Capacitor.registerPlugin('SystemFileSaver')
    : Capacitor.Plugins && Capacitor.Plugins.SystemFileSaver;

  if (!FilePicker || !SystemFileSaver) {
    console.error('Native file plugins are unavailable.');
    return;
  }

  let outputDirectory = localStorage.getItem('android-output-directory') || '';
  let pickerBusy = false;
  let nativeSaveQueue = Promise.resolve();
  const CHUNK_SIZE = 4 * 1024 * 1024;

  function setStatus(text) {
    const button = document.getElementById('androidOutputDirectoryButton');
    if (button) button.textContent = text;
  }

  async function chooseOutputDirectory() {
    if (pickerBusy) return outputDirectory;
    pickerBusy = true;
    try {
      const result = await FilePicker.pickDirectory();
      if (!result || !result.path) return outputDirectory;
      outputDirectory = result.path;
      localStorage.setItem('android-output-directory', outputDirectory);
      try {
        await SystemFileSaver.persistDirectory({ uri: outputDirectory });
      } catch (e) {
        console.warn('Could not persist directory permission:', e);
      }
      setStatus('📁 Папка сохранения: выбрана');
      return outputDirectory;
    } catch (e) {
      if (!String(e && e.message || e).toLowerCase().includes('canceled')) {
        console.error('Directory picker failed:', e);
        alert('Не удалось выбрать папку сохранения.');
      }
      return '';
    } finally {
      pickerBusy = false;
    }
  }

  async function ensureOutputDirectory() {
    if (outputDirectory) return outputDirectory;
    return chooseOutputDirectory();
  }

  function updateOutputButton() {
    const button = document.getElementById('androidOutputDirectoryButton');
    if (!button) return;
    button.textContent = outputDirectory ? '📁 Папка сохранения: выбрана' : '📁 Выбрать папку сохранения';
  }

  async function nativePickFiles(input, multiple, targetId) {
    try {
      const result = await FilePicker.pickFiles({ limit: multiple ? 0 : 1 });
      if (!result || !result.files || result.files.length === 0) return false;

      const files = [];
      for (const picked of result.files) {
        if (!picked.path) continue;
        const response = await fetch(Capacitor.convertFileSrc(picked.path));
        if (!response.ok) throw new Error(`Не удалось прочитать файл ${picked.name || ''}`);
        const blob = await response.blob();
        files.push(new File([blob], picked.name || 'file', {
          type: picked.mimeType || blob.type || 'application/octet-stream',
          lastModified: picked.modifiedAt || Date.now()
        }));
      }
      if (files.length === 0) return false;

      const dt = new DataTransfer();
      for (const file of files) dt.items.add(file);
      input.files = dt.files;
      if (typeof window.updateFileName === 'function') window.updateFileName(input, targetId);
      if (input.id === 'splitInput' && typeof window.updatePreview === 'function') window.updatePreview();
      if (input.id === 'mergeInput' && typeof window.checkPartsList === 'function') window.checkPartsList();
      return true;
    } catch (e) {
      if (!String(e && e.message || e).toLowerCase().includes('canceled')) {
        console.error('File picker failed:', e);
        alert('Не удалось выбрать файл.');
      }
      return false;
    }
  }

  function base64FromBlob(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error || new Error('Не удалось прочитать данные файла'));
      reader.onload = () => {
        const value = String(reader.result || '');
        const comma = value.indexOf(',');
        resolve(comma >= 0 ? value.slice(comma + 1) : value);
      };
      reader.readAsDataURL(blob);
    });
  }

  async function saveBlobNative(blob, fileName, mimeType) {
    const directory = await ensureOutputDirectory();
    if (!directory) return false;

    const started = await SystemFileSaver.startFile({
      directoryUri: directory,
      name: fileName,
      mimeType: mimeType || blob.type || 'application/octet-stream'
    });
    const uri = started && started.uri;
    if (!uri) throw new Error('Android не вернул URI файла.');

    try {
      for (let offset = 0; offset < blob.size; offset += CHUNK_SIZE) {
        const chunk = blob.slice(offset, Math.min(offset + CHUNK_SIZE, blob.size));
        const data = await base64FromBlob(chunk);
        await SystemFileSaver.writeChunk({ uri, data });
      }
      await SystemFileSaver.finishFile({ uri });
      return true;
    } catch (e) {
      try { await SystemFileSaver.finishFile({ uri }); } catch (_) {}
      throw e;
    }
  }

  document.addEventListener('click', (event) => {
    const link = event.target && event.target.closest ? event.target.closest('a[download]') : null;
    if (!link) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (link.dataset.androidSaving === '1') return;
    link.dataset.androidSaving = '1';

    nativeSaveQueue = nativeSaveQueue.then(async () => {
      try {
        const response = await fetch(link.href);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        const saved = await saveBlobNative(blob, link.getAttribute('download') || 'download.bin', blob.type);
        if (saved) {
          link.textContent = '✅ Сохранено';
          link.classList.add('downloaded');
        }
      } catch (e) {
        console.error('Native save failed:', e);
        alert(`Не удалось сохранить файл: ${e.message || e}`);
      } finally {
        delete link.dataset.androidSaving;
      }
    }).catch(() => {
      delete link.dataset.androidSaving;
    });
  }, true);

  function installFilePickers() {
    const splitLabel = document.getElementById('splitLabel');
    const splitInput = document.getElementById('splitInput');
    const mergeLabel = document.getElementById('mergeLabel');
    const mergeInput = document.getElementById('mergeInput');

    if (splitLabel && splitInput) {
      splitLabel.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
        await nativePickFiles(splitInput, false, 'splitInputText');
      }, true);
    }
    if (mergeLabel && mergeInput) {
      mergeLabel.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
        await nativePickFiles(mergeInput, true, 'mergeInputText');
      }, true);
    }
  }

  function installOutputDirectoryButton() {
    const title = document.querySelector('h1');
    if (!title || document.getElementById('androidOutputDirectoryButton')) return;
    const button = document.createElement('button');
    button.id = 'androidOutputDirectoryButton';
    button.type = 'button';
    button.style.cssText = 'display:block;width:100%;margin:10px 0 20px;padding:12px 16px;box-sizing:border-box;';
    button.addEventListener('click', chooseOutputDirectory);
    title.insertAdjacentElement('afterend', button);
    updateOutputButton();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      installFilePickers();
      installOutputDirectoryButton();
    });
  } else {
    installFilePickers();
    installOutputDirectoryButton();
  }
})();
