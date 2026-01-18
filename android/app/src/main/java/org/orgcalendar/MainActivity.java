package org.orgcalendar;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageButton;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

public class MainActivity extends Activity {
    private WebView webView;
    private LinearLayout settingsLayout;
    private EditText serverUrlInput;
    private TextView cancelButton;
    private TextView settingsSubtitle;
    private SharedPreferences prefs;
    private boolean hasValidUrl = false;
    private static final String PREF_SERVER_URL = "server_url";
    private static final String DEFAULT_URL = "http://192.168.1.100:8766";

    // Long press detection
    private Handler longPressHandler = new Handler(Looper.getMainLooper());
    private Runnable longPressRunnable;
    private boolean isLongPress = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        prefs = getSharedPreferences("OrgCalendar", MODE_PRIVATE);

        // Initialize notification channels
        NotificationHelper.createNotificationChannels(this);

        webView = findViewById(R.id.webView);
        settingsLayout = findViewById(R.id.settingsLayout);
        serverUrlInput = findViewById(R.id.serverUrlInput);
        cancelButton = findViewById(R.id.cancelButton);
        settingsSubtitle = findViewById(R.id.settingsSubtitle);
        Button saveButton = findViewById(R.id.saveButton);
        Button notificationSettingsButton = findViewById(R.id.notificationSettingsButton);
        FrameLayout rootLayout = findViewById(R.id.rootLayout);

        // Setup WebView
        setupWebView();

        // Schedule notifications if enabled
        boolean notificationsEnabled = prefs.getBoolean("notification_enabled", false);
        if (notificationsEnabled) {
            NotificationScheduler.scheduleNextAlarm(this);
        }

        // Load saved URL or show settings
        String savedUrl = prefs.getString(PREF_SERVER_URL, null);
        if (savedUrl != null) {
            hasValidUrl = true;
            serverUrlInput.setText(savedUrl);
            loadUrl(savedUrl);
        } else {
            serverUrlInput.setText(DEFAULT_URL);
            showSettings(false);
        }

        // Save button
        saveButton.setOnClickListener(v -> {
            String url = serverUrlInput.getText().toString().trim();
            if (!url.isEmpty()) {
                if (!url.startsWith("http://") && !url.startsWith("https://")) {
                    url = "http://" + url;
                }
                prefs.edit().putString(PREF_SERVER_URL, url).apply();
                hasValidUrl = true;
                loadUrl(url);
                hideSettings();
            } else {
                Toast.makeText(this, "Please enter a server URL", Toast.LENGTH_SHORT).show();
            }
        });

        // Cancel button
        cancelButton.setOnClickListener(v -> hideSettings());

        // Notification settings button - now opens unified settings
        notificationSettingsButton.setOnClickListener(v -> {
            hideSettings();
            openSettings();
        });

        // Long press on WebView to show settings page directly
        setupLongPress(rootLayout);
    }

    private void setupLongPress(View view) {
        longPressRunnable = () -> {
            isLongPress = true;
            openSettings();
        };

        view.setOnTouchListener((v, event) -> {
            switch (event.getAction()) {
                case android.view.MotionEvent.ACTION_DOWN:
                    isLongPress = false;
                    longPressHandler.postDelayed(longPressRunnable, 1500); // 1.5 second long press
                    break;
                case android.view.MotionEvent.ACTION_UP:
                case android.view.MotionEvent.ACTION_CANCEL:
                    longPressHandler.removeCallbacks(longPressRunnable);
                    if (isLongPress) {
                        isLongPress = false;
                        return true; // Consume the event
                    }
                    break;
                case android.view.MotionEvent.ACTION_MOVE:
                    // Cancel long press if finger moves too much
                    break;
            }
            return false; // Let WebView handle touch events
        });
    }

    private void setupWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setAllowFileAccess(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        
        // Enable responsive design
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        
        // Enable service worker support (required for offline functionality)
        // Service workers need these additional settings
        settings.setAllowContentAccess(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                // Don't show settings for network errors - let the PWA handle offline mode
                if (errorCode == WebViewClient.ERROR_CONNECT || 
                    errorCode == WebViewClient.ERROR_HOST_LOOKUP || 
                    errorCode == WebViewClient.ERROR_TIMEOUT) {
                    // Network errors - the PWA should handle this with its service worker
                    return;
                }
                Toast.makeText(MainActivity.this, 
                    "Connection error: " + description, 
                    Toast.LENGTH_LONG).show();
                showSettings(true);
            }
        });

        webView.setWebChromeClient(new WebChromeClient());
    }

    private void loadUrl(String url) {
        webView.loadUrl(url);
        webView.setVisibility(View.VISIBLE);
    }

    private void showSettings(boolean showCancel) {
        settingsLayout.setVisibility(View.VISIBLE);
        cancelButton.setVisibility(showCancel && hasValidUrl ? View.VISIBLE : View.GONE);
        settingsSubtitle.setText(hasValidUrl ? "Change server address" : "Enter your server address");
    }

    private void hideSettings() {
        settingsLayout.setVisibility(View.GONE);
    }

    /**
     * Open unified settings activity.
     */
    private void openSettings() {
        Intent intent = new Intent(this, SettingsActivity.class);
        startActivity(intent);
    }

    @Override
    public void onBackPressed() {
        if (settingsLayout.getVisibility() == View.VISIBLE && hasValidUrl) {
            hideSettings();
        } else if (webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }
}
