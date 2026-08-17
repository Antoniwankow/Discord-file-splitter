import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const androidRoot = resolve(root, 'android-app/android');
const javaRoot = resolve(androidRoot, 'app/src/main/java');

async function findFile(dir, wanted) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isFile() && entry.name === wanted) return full;
    if (entry.isDirectory()) {
      const found = await findFile(full, wanted);
      if (found) return found;
    }
  }
  return null;
}

const mainActivity = await findFile(javaRoot, 'MainActivity.java');
if (!mainActivity) throw new Error(`MainActivity.java not found under ${javaRoot}`);

const mainSource = await readFile(mainActivity, 'utf8');
const packageMatch = mainSource.match(/^package\s+([\w.]+);/m);
if (!packageMatch) throw new Error('Could not determine MainActivity package');
const packageName = packageMatch[1];
const packageDir = join(javaRoot, ...packageName.split('.'));
await mkdir(packageDir, { recursive: true });

const pluginSource = `package ${packageName};

import android.content.ContentResolver;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.OutputStream;

@CapacitorPlugin(name = "SystemFileSaver")
public class SystemFileSaverPlugin extends Plugin {
    @PluginMethod
    public void persistDirectory(PluginCall call) {
        String uriString = call.getString("uri");
        if (uriString == null) {
            call.reject("uri is required");
            return;
        }
        try {
            Uri uri = Uri.parse(uriString);
            int flags = android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION
                | android.content.Intent.FLAG_GRANT_WRITE_URI_PERMISSION;
            getContext().getContentResolver().takePersistableUriPermission(uri, flags);
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage(), e);
        }
    }

    @PluginMethod
    public void startFile(PluginCall call) {
        String directoryUriString = call.getString("directoryUri");
        String name = call.getString("name");
        String mimeType = call.getString("mimeType", "application/octet-stream");
        if (directoryUriString == null || name == null) {
            call.reject("directoryUri and name are required");
            return;
        }
        try {
            ContentResolver resolver = getContext().getContentResolver();
            Uri directoryUri = Uri.parse(directoryUriString);
            Uri fileUri = DocumentsContract.createDocument(resolver, directoryUri, mimeType, name);
            if (fileUri == null) throw new Exception("Could not create destination file");
            JSObject result = new JSObject();
            result.put("uri", fileUri.toString());
            call.resolve(result);
        } catch (Exception e) {
            call.reject(e.getMessage(), e);
        }
    }

    @PluginMethod
    public void writeChunk(PluginCall call) {
        String uriString = call.getString("uri");
        String data = call.getString("data");
        if (uriString == null || data == null) {
            call.reject("uri and data are required");
            return;
        }
        try {
            byte[] bytes = Base64.decode(data, Base64.DEFAULT);
            OutputStream output = getContext().getContentResolver().openOutputStream(Uri.parse(uriString), "wa");
            if (output == null) throw new Exception("Could not open destination file");
            output.write(bytes);
            output.flush();
            output.close();
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage(), e);
        }
    }

    @PluginMethod
    public void finishFile(PluginCall call) {
        call.resolve();
    }
}
`;

await writeFile(join(packageDir, 'SystemFileSaverPlugin.java'), pluginSource, 'utf8');

let updated = mainSource;
if (!updated.includes('import android.os.Bundle;')) {
  updated = updated.replace(/(package\s+[\w.]+;\s*)/, '$1\nimport android.os.Bundle;\n');
}
if (!updated.includes('SystemFileSaverPlugin.class')) {
  const onCreate = /public\s+void\s+onCreate\s*\(\s*Bundle\s+savedInstanceState\s*\)\s*\{/;
  if (onCreate.test(updated)) {
    updated = updated.replace(onCreate, match => `${match}\n        registerPlugin(SystemFileSaverPlugin.class);`);
  } else {
    updated = updated.replace(/\}\s*$/, `    @Override\n    public void onCreate(Bundle savedInstanceState) {\n        registerPlugin(SystemFileSaverPlugin.class);\n        super.onCreate(savedInstanceState);\n    }\n}\n`);
  }
}
await writeFile(mainActivity, updated, 'utf8');
console.log(`Configured SystemFileSaverPlugin in ${mainActivity}`);
