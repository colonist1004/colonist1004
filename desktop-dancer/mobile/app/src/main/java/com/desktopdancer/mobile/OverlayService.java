package com.desktopdancer.mobile;

import android.annotation.SuppressLint;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.provider.Settings;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.ViewConfiguration;
import android.view.WindowManager;
import android.webkit.WebView;

/**
 * Floating dancer on top of other apps. The window is exactly the character's box (so touches
 * elsewhere reach the apps below, as Android 12+ requires); drag it with a finger, long-press to
 * open the settings. Runs as a foreground service with a notification that can hide it.
 */
public class OverlayService extends Service {
    static final String ACTION_STOP = "com.desktopdancer.mobile.STOP_OVERLAY";
    private static final String CHANNEL = "overlay";
    private static final float BASE_W_DP = 150f, BASE_H_DP = 160f;

    static volatile OverlayService instance;

    private final Handler main = new Handler(Looper.getMainLooper());
    private WindowManager wm;
    private WebView web;
    private WindowManager.LayoutParams lp;

    static boolean isRunning() {
        return instance != null;
    }

    static boolean canDraw(Context c) {
        return Settings.canDrawOverlays(c);
    }

    /** Settings changed: resize and let the page refresh. Safe to call from any thread. */
    static void settingsChanged() {
        OverlayService s = instance;
        if (s != null) s.main.post(s::apply);
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        startInForeground();
        if (!canDraw(this)) {
            stopSelf();
            return;
        }
        instance = this;
        wm = (WindowManager) getSystemService(WINDOW_SERVICE);
        web = DancerWebView.create(this, "dancer.html?mode=overlay");
        lp = new WindowManager.LayoutParams(
                1, 1,
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                PixelFormat.TRANSLUCENT);
        lp.gravity = Gravity.TOP | Gravity.START;
        size();
        Rect scr = screen();
        float x = Prefs.num(this, Prefs.OVERLAY_X), y = Prefs.num(this, Prefs.OVERLAY_Y);
        lp.x = x >= 0 ? (int) x : scr.width() - lp.width - dp(12);
        lp.y = y >= 0 ? (int) y : scr.height() - lp.height - dp(96); // above the navigation bar
        clamp();
        setupTouch();
        wm.addView(web, lp);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) stopSelf();
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        instance = null;
        if (web != null) {
            try {
                wm.removeView(web);
            } catch (IllegalArgumentException ignored) {
            }
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    private void apply() {
        if (web == null) return;
        size();
        clamp();
        wm.updateViewLayout(web, lp);
        web.evaluateJavascript("window.dancer && dancer.refresh()", null);
    }

    private void size() {
        float s = Prefs.num(this, Prefs.SCALE);
        Rect scr = screen();
        lp.width = Math.min(scr.width(), Math.round(dp(BASE_W_DP) * s));
        lp.height = Math.min(scr.height(), Math.round(dp(BASE_H_DP) * s));
    }

    private void clamp() {
        Rect scr = screen();
        lp.x = Math.max(0, Math.min(scr.width() - lp.width, lp.x));
        lp.y = Math.max(0, Math.min(scr.height() - lp.height, lp.y));
    }

    private Rect screen() {
        if (Build.VERSION.SDK_INT >= 30) return wm.getCurrentWindowMetrics().getBounds();
        android.util.DisplayMetrics dm = getResources().getDisplayMetrics();
        return new Rect(0, 0, dm.widthPixels, dm.heightPixels);
    }

    private int dp(float v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    @SuppressLint("ClickableViewAccessibility")
    private void setupTouch() {
        final int slop = ViewConfiguration.get(this).getScaledTouchSlop();
        final Runnable longPress = () -> {
            Intent i = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(i);
        };
        web.setOnTouchListener(new android.view.View.OnTouchListener() {
            float downX, downY;
            int startX, startY;
            boolean dragging;

            @Override
            public boolean onTouch(android.view.View v, MotionEvent e) {
                switch (e.getActionMasked()) {
                    case MotionEvent.ACTION_DOWN:
                        downX = e.getRawX();
                        downY = e.getRawY();
                        startX = lp.x;
                        startY = lp.y;
                        dragging = false;
                        main.postDelayed(longPress, ViewConfiguration.getLongPressTimeout() + 200);
                        return true;
                    case MotionEvent.ACTION_MOVE:
                        float dx = e.getRawX() - downX, dy = e.getRawY() - downY;
                        if (!dragging && Math.hypot(dx, dy) > slop) {
                            dragging = true;
                            main.removeCallbacks(longPress);
                        }
                        if (dragging) {
                            lp.x = startX + Math.round(dx);
                            lp.y = startY + Math.round(dy);
                            clamp();
                            wm.updateViewLayout(web, lp);
                        }
                        return true;
                    case MotionEvent.ACTION_UP:
                    case MotionEvent.ACTION_CANCEL:
                        main.removeCallbacks(longPress);
                        if (dragging) {
                            Prefs.sp(OverlayService.this).edit()
                                    .putFloat(Prefs.OVERLAY_X, lp.x).putFloat(Prefs.OVERLAY_Y, lp.y).apply();
                        }
                        return true;
                    default:
                        return true;
                }
            }
        });
    }

    private void startInForeground() {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        nm.createNotificationChannel(new NotificationChannel(CHANNEL, "화면 위 캐릭터", NotificationManager.IMPORTANCE_LOW));
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        PendingIntent stop = PendingIntent.getService(this, 1, new Intent(this, OverlayService.class).setAction(ACTION_STOP),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification n = new Notification.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_fg)
                .setContentTitle("캐릭터가 화면 위에서 춤추는 중")
                .setContentText("눌러서 설정 · 길게 눌러 옮기기는 캐릭터에서")
                .setContentIntent(open)
                .addAction(new Notification.Action.Builder(null, "숨기기", stop).build())
                .setOngoing(true)
                .build();
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(1, n);
        }
    }
}
