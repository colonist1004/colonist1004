package com.desktopdancer.mobile;

import android.Manifest;
import android.app.Activity;
import android.app.WallpaperManager;
import android.content.ActivityNotFoundException;
import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.provider.Settings;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;

/** Settings screen (an HTML page: assets/web/settings.html) with window.App for native actions. */
public class MainActivity extends Activity {
    private static final int PICK_FILES = 1;
    private WebView web;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        web = DancerWebView.create(this, "settings.html", new App(), "App");
        web.setBackgroundColor(0xFFF4F5F8);
        setContentView(web);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.evaluateJavascript("window.onAppResume && onAppResume()", null);
    }

    @Override
    protected void onDestroy() {
        if (web != null) web.destroy();
        super.onDestroy();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != PICK_FILES || resultCode != RESULT_OK || data == null) return;
        JSONArray added = new JSONArray();
        if (data.getClipData() != null) {
            for (int i = 0; i < data.getClipData().getItemCount(); i++) {
                String n = importFile(data.getClipData().getItemAt(i).getUri());
                if (n != null) added.put(n);
            }
        } else if (data.getData() != null) {
            String n = importFile(data.getData());
            if (n != null) added.put(n);
        }
        String js = "window.onFilesAdded && onFilesAdded(" + JSONObject.quote(added.toString()) + ")";
        web.evaluateJavascript(js, null);
    }

    /** Copies a picked file into the library by extension. Returns the stored name or null. */
    private String importFile(Uri uri) {
        String name = "file";
        try (Cursor c = getContentResolver().query(uri, new String[] {OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst()) name = c.getString(0);
        } catch (RuntimeException ignored) {
        }
        name = name.replaceAll("[\\\\/:*?\"<>|]", "_");
        String lower = name.toLowerCase();
        String kind;
        if (lower.endsWith(".vrm") || lower.endsWith(".custom.json")) kind = "characters";
        else if (lower.endsWith(".vrma")) kind = "motions";
        else {
            Toast.makeText(this, name + ": .vrm / .vrma / .custom.json 파일만 추가할 수 있어요", Toast.LENGTH_LONG).show();
            return null;
        }
        File out = new File(Library.dir(this, kind), name);
        try (InputStream in = getContentResolver().openInputStream(uri); OutputStream os = new FileOutputStream(out)) {
            if (in == null) return null;
            byte[] buf = new byte[65536];
            int r;
            while ((r = in.read(buf)) > 0) os.write(buf, 0, r);
            return name;
        } catch (Exception e) {
            Toast.makeText(this, name + ": 복사 실패 (" + e.getMessage() + ")", Toast.LENGTH_LONG).show();
            return null;
        }
    }

    /** window.App */
    final class App {
        @JavascriptInterface
        public String getState() {
            try {
                JSONObject o = new JSONObject();
                o.put("settings", Prefs.toJson(MainActivity.this));
                o.put("characters", Library.list(MainActivity.this, "characters"));
                o.put("motions", Library.list(MainActivity.this, "motions"));
                o.put("overlay", new JSONObject()
                        .put("permission", OverlayService.canDraw(MainActivity.this))
                        .put("running", OverlayService.isRunning()));
                return o.toString();
            } catch (JSONException e) {
                return "{}";
            }
        }

        @JavascriptInterface
        public boolean setSetting(String key, String json) {
            boolean ok = Prefs.set(MainActivity.this, key, json);
            if (ok) {
                OverlayService.settingsChanged();
                DancerWallpaperService.settingsChanged();
            }
            return ok;
        }

        @JavascriptInterface
        public void pickFiles(String kind) {
            runOnUiThread(() -> {
                Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT)
                        .addCategory(Intent.CATEGORY_OPENABLE)
                        .setType("*/*")
                        .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                startActivityForResult(i, PICK_FILES);
            });
        }

        @JavascriptInterface
        public void requestOverlayPermission() {
            runOnUiThread(() -> startActivity(new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    Uri.parse("package:" + getPackageName()))));
        }

        @JavascriptInterface
        public void startOverlay() {
            runOnUiThread(() -> {
                if (Build.VERSION.SDK_INT >= 33
                        && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                    requestPermissions(new String[] {Manifest.permission.POST_NOTIFICATIONS}, 2);
                }
                if (!OverlayService.canDraw(MainActivity.this)) {
                    requestOverlayPermission();
                    return;
                }
                startForegroundService(new Intent(MainActivity.this, OverlayService.class));
            });
        }

        @JavascriptInterface
        public void stopOverlay() {
            runOnUiThread(() -> stopService(new Intent(MainActivity.this, OverlayService.class)));
        }

        @JavascriptInterface
        public void setWallpaper() {
            runOnUiThread(() -> {
                Intent i = new Intent(WallpaperManager.ACTION_CHANGE_LIVE_WALLPAPER)
                        .putExtra(WallpaperManager.EXTRA_LIVE_WALLPAPER_COMPONENT,
                                new ComponentName(MainActivity.this, DancerWallpaperService.class));
                try {
                    startActivity(i);
                } catch (ActivityNotFoundException e) {
                    try {
                        startActivity(new Intent(WallpaperManager.ACTION_LIVE_WALLPAPER_CHOOSER));
                    } catch (ActivityNotFoundException e2) {
                        Toast.makeText(MainActivity.this, "이 기기는 라이브 배경화면을 지원하지 않아요", Toast.LENGTH_LONG).show();
                    }
                }
            });
        }
    }
}
