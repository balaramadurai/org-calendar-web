package org.orgcalendar;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/**
 * Receives alarm broadcasts and triggers event notifications.
 * After showing notification, reschedules the next alarm.
 */
public class AlarmReceiver extends BroadcastReceiver {
    private static final String TAG = "AlarmReceiver";

    @Override
    public void onReceive(Context context, Intent intent) {
        Log.d(TAG, "Alarm received");

        // Extract event from intent
        Event event = (Event) intent.getSerializableExtra("event");
        int leadTimeMinutes = intent.getIntExtra("lead_time", 15);

        if (event == null) {
            Log.e(TAG, "No event in alarm intent");
            return;
        }

        // Show notification
        try {
            NotificationHelper.showEventNotification(context, event, leadTimeMinutes);
            Log.d(TAG, "Showed notification for: " + event.title);

            // Record that we notified for this event
            NotificationScheduler.recordNotification(context, event);
        } catch (Exception e) {
            Log.e(TAG, "Failed to show notification", e);
        }

        // Schedule next alarm
        try {
            NotificationScheduler.scheduleNextAlarm(context);
            Log.d(TAG, "Rescheduled next alarm");
        } catch (Exception e) {
            Log.e(TAG, "Failed to reschedule alarm", e);
        }
    }
}
