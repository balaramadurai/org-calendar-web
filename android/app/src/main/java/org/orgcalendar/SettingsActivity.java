package org.orgcalendar;

import android.Manifest;
import android.app.AlertDialog;
import android.app.TimePickerDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.util.Log;
import android.widget.Toast;

import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.preference.EditTextPreference;
import androidx.preference.ListPreference;
import androidx.preference.Preference;
import androidx.preference.PreferenceFragmentCompat;
import androidx.preference.PreferenceManager;
import androidx.preference.SwitchPreferenceCompat;

import java.util.Locale;

/**
 * Settings Activity for notification preferences.
 * Uses PreferenceFragmentCompat for modern preferences UI.
 */
public class SettingsActivity extends AppCompatActivity {
    private static final String TAG = "SettingsActivity";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_settings);

        // Show settings fragment
        if (savedInstanceState == null) {
            getSupportFragmentManager()
                    .beginTransaction()
                    .replace(R.id.settings_container, new SettingsFragment())
                    .commit();
        }

        // Enable back button in action bar
        if (getSupportActionBar() != null) {
            getSupportActionBar().setDisplayHomeAsUpEnabled(true);
        }
    }

    @Override
    public boolean onSupportNavigateUp() {
        finish();
        return true;
    }

    /**
     * Settings Fragment containing all preference UI.
     */
    public static class SettingsFragment extends PreferenceFragmentCompat
            implements SharedPreferences.OnSharedPreferenceChangeListener {

        private static final int PERMISSION_REQUEST_POST_NOTIFICATIONS = 1001;
        private static final int PERMISSION_REQUEST_SCHEDULE_ALARM = 1002;

        @Override
        public void onCreatePreferences(Bundle savedInstanceState, String rootKey) {
            setPreferencesFromResource(R.xml.preferences, rootKey);

            // Set up server URL preference
            EditTextPreference serverUrlPref = findPreference("server_url");
            if (serverUrlPref != null) {
                // Update summary to show current URL
                String currentUrl = serverUrlPref.getText();
                if (currentUrl != null && !currentUrl.isEmpty()) {
                    serverUrlPref.setSummary(currentUrl);
                }

                serverUrlPref.setOnPreferenceChangeListener((preference, newValue) -> {
                    String url = (String) newValue;
                    if (url != null && !url.isEmpty()) {
                        // Add http:// if not present
                        if (!url.startsWith("http://") && !url.startsWith("https://")) {
                            url = "http://" + url;
                        }
                        preference.setSummary(url);

                        // Show toast to indicate server URL changed
                        android.widget.Toast.makeText(requireContext(),
                            "Server URL updated. Restart app to apply changes.",
                            android.widget.Toast.LENGTH_LONG).show();
                        return true;
                    }
                    return false;
                });
            }

            // Set up notification enabled preference
            SwitchPreferenceCompat notificationPref = findPreference("notification_enabled");
            if (notificationPref != null) {
                notificationPref.setOnPreferenceChangeListener((preference, newValue) -> {
                    boolean enabled = (Boolean) newValue;
                    if (enabled) {
                        return checkAndRequestPermissions();
                    } else {
                        // Disable notifications
                        NotificationScheduler.cancelAllAlarms(requireContext());
                        return true;
                    }
                });
            }

            // Set up lead time preference
            ListPreference leadTimePref = findPreference("notification_lead_time");
            if (leadTimePref != null) {
                updateLeadTimeSummary(leadTimePref);
            }

            // Set up daily summary time preference
            Preference summaryTimePref = findPreference("daily_summary_time");
            if (summaryTimePref != null) {
                updateSummaryTimeSummary(summaryTimePref);
                summaryTimePref.setOnPreferenceClickListener(preference -> {
                    showTimePickerDialog();
                    return true;
                });
            }

            // Set up daily summary enabled preference
            SwitchPreferenceCompat dailySummaryPref = findPreference("daily_summary_enabled");
            if (dailySummaryPref != null) {
                dailySummaryPref.setOnPreferenceChangeListener((preference, newValue) -> {
                    boolean enabled = (Boolean) newValue;
                    if (enabled) {
                        DailySummaryWorker.scheduleDaily(requireContext());
                    } else {
                        DailySummaryWorker.cancelDaily(requireContext());
                    }
                    return true;
                });
            }
        }

        @Override
        public void onResume() {
            super.onResume();
            getPreferenceScreen().getSharedPreferences()
                    .registerOnSharedPreferenceChangeListener(this);
        }

        @Override
        public void onPause() {
            super.onPause();
            getPreferenceScreen().getSharedPreferences()
                    .unregisterOnSharedPreferenceChangeListener(this);
        }

        @Override
        public void onSharedPreferenceChanged(SharedPreferences sharedPreferences, String key) {
            Log.d(TAG, "Preference changed: " + key);

            // Update summaries
            if ("notification_lead_time".equals(key)) {
                ListPreference leadTimePref = findPreference(key);
                if (leadTimePref != null) {
                    updateLeadTimeSummary(leadTimePref);
                }
            }

            // Reschedule notifications when relevant settings change
            boolean notificationsEnabled = sharedPreferences.getBoolean("notification_enabled", false);
            if (notificationsEnabled) {
                if ("notification_enabled".equals(key) ||
                    "org_notifications_enabled".equals(key) ||
                    "ics_notifications_enabled".equals(key) ||
                    "notification_lead_time".equals(key)) {

                    // Reschedule with new settings
                    NotificationScheduler.scheduleNextAlarm(requireContext());
                    Toast.makeText(requireContext(), "Notifications rescheduled", Toast.LENGTH_SHORT).show();
                }
            }
        }

        /**
         * Check and request necessary permissions for notifications.
         */
        private boolean checkAndRequestPermissions() {
            // Check POST_NOTIFICATIONS permission (Android 13+)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                if (requireContext().checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                        != PackageManager.PERMISSION_GRANTED) {

                    // Show rationale
                    new AlertDialog.Builder(requireContext())
                            .setTitle(R.string.notification_permission_required)
                            .setMessage(R.string.notification_permission_rationale)
                            .setPositiveButton("OK", (dialog, which) -> {
                                requestPermissions(
                                        new String[]{Manifest.permission.POST_NOTIFICATIONS},
                                        PERMISSION_REQUEST_POST_NOTIFICATIONS
                                );
                            })
                            .setNegativeButton("Cancel", (dialog, which) -> {
                                Toast.makeText(requireContext(), "Notification permission required", Toast.LENGTH_SHORT).show();
                            })
                            .show();

                    return false; // Don't enable yet
                }
            }

            // Check SCHEDULE_EXACT_ALARM permission (Android 12+)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                android.app.AlarmManager alarmManager =
                        (android.app.AlarmManager) requireContext().getSystemService(android.content.Context.ALARM_SERVICE);

                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !alarmManager.canScheduleExactAlarms()) {
                    // Show dialog to open settings
                    new AlertDialog.Builder(requireContext())
                            .setTitle("Exact Alarm Permission Required")
                            .setMessage("To receive timely notifications, please allow this app to schedule exact alarms in system settings.")
                            .setPositiveButton("Open Settings", (dialog, which) -> {
                                Intent intent = new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM);
                                intent.setData(Uri.parse("package:" + requireContext().getPackageName()));
                                startActivity(intent);
                            })
                            .setNegativeButton("Cancel", null)
                            .show();
                }
            }

            // Schedule notifications
            NotificationScheduler.scheduleNextAlarm(requireContext());
            return true;
        }

        @Override
        public void onRequestPermissionsResult(int requestCode, @NonNull String[] permissions,
                                                @NonNull int[] grantResults) {
            super.onRequestPermissionsResult(requestCode, permissions, grantResults);

            if (requestCode == PERMISSION_REQUEST_POST_NOTIFICATIONS) {
                if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                    Toast.makeText(requireContext(), "Notification permission granted", Toast.LENGTH_SHORT).show();
                    // Schedule notifications
                    NotificationScheduler.scheduleNextAlarm(requireContext());
                } else {
                    Toast.makeText(requireContext(), "Notification permission denied", Toast.LENGTH_LONG).show();
                    // Disable the preference
                    SwitchPreferenceCompat notificationPref = findPreference("notification_enabled");
                    if (notificationPref != null) {
                        notificationPref.setChecked(false);
                    }
                }
            }
        }

        /**
         * Update lead time preference summary.
         */
        private void updateLeadTimeSummary(ListPreference preference) {
            String value = preference.getValue();
            if (value != null) {
                int index = preference.findIndexOfValue(value);
                if (index >= 0) {
                    preference.setSummary(preference.getEntries()[index]);
                }
            }
        }

        /**
         * Update daily summary time preference summary.
         */
        private void updateSummaryTimeSummary(Preference preference) {
            SharedPreferences prefs = PreferenceManager.getDefaultSharedPreferences(requireContext());
            String time = prefs.getString("daily_summary_time", "08:00");
            preference.setSummary("Daily summary at " + time);
        }

        /**
         * Show time picker dialog for daily summary time.
         */
        private void showTimePickerDialog() {
            SharedPreferences prefs = PreferenceManager.getDefaultSharedPreferences(requireContext());
            String currentTime = prefs.getString("daily_summary_time", "08:00");

            // Parse current time
            String[] parts = currentTime.split(":");
            int hour = Integer.parseInt(parts[0]);
            int minute = Integer.parseInt(parts[1]);

            TimePickerDialog timePickerDialog = new TimePickerDialog(
                    requireContext(),
                    (view, selectedHour, selectedMinute) -> {
                        // Save selected time
                        String timeString = String.format(Locale.US, "%02d:%02d", selectedHour, selectedMinute);
                        prefs.edit().putString("daily_summary_time", timeString).apply();

                        // Update summary
                        Preference summaryTimePref = findPreference("daily_summary_time");
                        if (summaryTimePref != null) {
                            updateSummaryTimeSummary(summaryTimePref);
                        }

                        // Reschedule daily summary
                        boolean enabled = prefs.getBoolean("daily_summary_enabled", false);
                        if (enabled) {
                            DailySummaryWorker.scheduleDaily(requireContext());
                            Toast.makeText(requireContext(), "Daily summary rescheduled", Toast.LENGTH_SHORT).show();
                        }
                    },
                    hour,
                    minute,
                    true // 24-hour format
            );

            timePickerDialog.setTitle("Select Time");
            timePickerDialog.show();
        }
    }
}
