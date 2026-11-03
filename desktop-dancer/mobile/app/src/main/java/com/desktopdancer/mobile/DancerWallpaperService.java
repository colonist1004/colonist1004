package com.desktopdancer.mobile;

import android.app.Presentation;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.os.Handler;
import android.os.Looper;
import android.service.wallpaper.WallpaperService;
import android.view.SurfaceHolder;
import android.view.ViewGroup;
import android.webkit.WebView;

import java.util.Set;
import java.util.concurrent.CopyOnWriteArraySet;

/**
 * Live wallpaper. A wallpaper only gets a Surface, so the WebView is shown on a private
 * VirtualDisplay that renders into that Surface (through a Presentation). The page is paused while
 * the wallpaper is not visible.
 */
public class DancerWallpaperService extends WallpaperService {
    static final Set<Engine> engines = new CopyOnWriteArraySet<>();
    private static final Handler main = new Handler(Looper.getMainLooper());

    static void settingsChanged() {
        main.post(() -> {
            for (Engine e : engines) ((DancerEngine) e).refresh();
        });
    }

    @Override
    public Engine onCreateEngine() {
        return new DancerEngine();
    }

    final class DancerEngine extends Engine {
        private VirtualDisplay display;
        private Presentation presentation;
        private WebView web;

        @Override
        public void onCreate(SurfaceHolder holder) {
            super.onCreate(holder);
            setTouchEventsEnabled(false);
            engines.add(this);
        }

        @Override
        public void onSurfaceChanged(SurfaceHolder holder, int format, int width, int height) {
            super.onSurfaceChanged(holder, format, width, height);
            int dpi = getResources().getDisplayMetrics().densityDpi;
            if (display == null) {
                DisplayManager dm = (DisplayManager) getSystemService(DISPLAY_SERVICE);
                display = dm.createVirtualDisplay("dancer-wallpaper", width, height, dpi, holder.getSurface(), 0);
                presentation = new Presentation(DancerWallpaperService.this, display.getDisplay());
                web = DancerWebView.create(presentation.getContext(), "dancer.html?mode=wallpaper");
                presentation.setContentView(web, new ViewGroup.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                presentation.show();
            } else {
                display.setSurface(holder.getSurface());
                display.resize(width, height, dpi);
            }
        }

        @Override
        public void onVisibilityChanged(boolean visible) {
            super.onVisibilityChanged(visible);
            if (web == null) return;
            if (visible) {
                web.onResume();
                web.evaluateJavascript("window.dancer && dancer.resume()", null);
            } else {
                web.evaluateJavascript("window.dancer && dancer.pause()", null);
                web.onPause();
            }
        }

        void refresh() {
            if (web != null) web.evaluateJavascript("window.dancer && dancer.refresh()", null);
        }

        @Override
        public void onSurfaceDestroyed(SurfaceHolder holder) {
            release();
            super.onSurfaceDestroyed(holder);
        }

        @Override
        public void onDestroy() {
            engines.remove(this);
            release();
            super.onDestroy();
        }

        private void release() {
            if (presentation != null) {
                presentation.dismiss();
                presentation = null;
            }
            if (web != null) {
                web.destroy();
                web = null;
            }
            if (display != null) {
                display.release();
                display = null;
            }
        }
    }
}
