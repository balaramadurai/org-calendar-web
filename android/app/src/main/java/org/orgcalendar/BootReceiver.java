package org.orgcalendar;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.util.Log;

/**
 * Receives boot completed broadcasts and reschedules notification alarms.
 * Android clears all alarms on reboot, so we need to reschedule them.
 */
public class BootReceiver extends BroadcastReceiver {
    private static final String TAG = "BootReceiver";
    private static final String PREFS_NAME = "OrgCalendar";
    private static final String PREF_NOTIFICATION_ENABLED = "notification_enabled";

    // Vendor-specific action (not in standard Android SDK)
    private static final String ACTION_QUICKBOOT_POWERON = "android.intent.action.QUICKBOOT_POWERON";

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();

        if (Intent.ACTION_BOOT_COMPLETED.equals(action) ||
            ACTION_QUICKBOOT_POWERON.equals(action)) {

            Log.d(TAG, "Device booted, rescheduling notifications");

            // Check if notifications are enabled
            SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            if (!prefs.getBoolean(PREF_NOTIFICATION_ENABLED, false)) {
                Log.d(TAG, "Notifications disabled, skipping reschedule");
                return;
            }

            // Reschedule notifications
            try {
                NotificationScheduler.scheduleNextAlarm(context);
                Log.d(TAG, "Successfully rescheduled notifications after boot");
            } catch (Exception e) {
                Log.e(TAG, "Failed to reschedule notifications after boot", e);
            }
        }
    }
}
