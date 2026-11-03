package com.desktopdancer.mobile;

import android.annotation.SuppressLint;
import android.content.Context;
import android.graphics.Color;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.webkit.WebViewAssetLoader;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * WebViews that run the shared three.js renderer. Pages are served from
 * https://appassets.androidplatform.net (ES modules need a real origin):
 *   /assets/...  -> APK assets (assets/web: pages, vendor libs, samples)
 *   /library/... -> files the user added (filesDir/library)
 */
final class DancerWebView {
    static final String BASE = "https://appassets.androidplatform.net/assets/web/";

    private DancerWebView() {}

    static WebView create(Context ctx, String page) {
        return create(ctx, page, null, null);
    }

    /** extra/extraName: an additional JavaScript interface, registered before the page loads. */
    @SuppressLint({"SetJavaScriptEnabled", "JavascriptInterface"})
    static WebView create(Context ctx, String page, Object extra, String extraName) {
        WebView w = new WebView(ctx);
        WebSettings s = w.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        w.setBackgroundColor(Color.TRANSPARENT);
        w.setVerticalScrollBarEnabled(false);
        w.setHorizontalScrollBarEnabled(false);
        Context app = ctx.getApplicationContext();
        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(app))
                .addPathHandler("/library/", new WebViewAssetLoader.InternalStoragePathHandler(app, Library.root(app)))
                .build();
        w.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                return loader.shouldInterceptRequest(req.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                return true; // never navigate away
            }
        });
        w.addJavascriptInterface(new Bridge(app), "Android");
        if (extra != null) w.addJavascriptInterface(extra, extraName);
        w.loadUrl(BASE + page);
        return w;
    }

    /** window.Android for dancer.html: what to show and how. */
    static final class Bridge {
        private final Context c;

        Bridge(Context c) {
            this.c = c;
        }

        @JavascriptInterface
        public String getConfig(String mode) {
            try {
                String ch = Prefs.str(c, Prefs.CHARACTER);
                String mo = Prefs.str(c, Prefs.MOTION);
                if (!Library.exists(c, ch)) ch = "asset:mannequin.vrm";
                if (!Library.exists(c, mo)) mo = "asset:sample-dance.vrma";
                JSONObject o = new JSONObject();
                o.put("mode", mode);
                o.put("character", Library.url(ch));
                o.put("characterId", ch);
                o.put("motion", Library.url(mo));
                JSONObject custom = Library.custom(c, ch);
                if (custom != null) o.put("custom", custom);
                o.put("speed", Prefs.num(c, Prefs.SPEED));
                o.put("fps", Prefs.num(c, Prefs.FPS));
                o.put("bg", Prefs.str(c, Prefs.BG));
                o.put("wpScale", Prefs.num(c, Prefs.WP_SCALE));
                o.put("wpX", Prefs.num(c, Prefs.WP_X));
                o.put("wpY", Prefs.num(c, Prefs.WP_Y));
                return o.toString();
            } catch (JSONException e) {
                return "{}";
            }
        }

        @JavascriptInterface
        public void log(String msg) {
            Log.w("Dancer", msg);
        }
    }
}
