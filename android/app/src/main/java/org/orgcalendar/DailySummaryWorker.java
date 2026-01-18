package org.orgcalendar;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.TimeUnit;

/**
 * WorkManager worker for daily summary notifications.
 * Runs once per day at the configured time to show a summary of today's events.
 */
public class DailySummaryWorker extends Worker {
    private static final String TAG = "DailySummaryWorker";
    private static final String WORK_NAME = "daily_summary";

    public DailySummaryWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        Log.d(TAG, "Daily summary worker executing");

        try {
            // Check if daily summary is enabled
            SharedPreferences prefs = getApplicationContext()
                    .getSharedPreferences("OrgCalendar", Context.MODE_PRIVATE);
            boolean enabled = prefs.getBoolean("daily_summary_enabled", false);

            if (!enabled) {
                Log.d(TAG, "Daily summary disabled, skipping");
                return Result.success();
            }

            // Fetch today's events
            List<Event> todaysEvents = fetchTodaysEvents();

            if (todaysEvents.isEmpty()) {
                Log.d(TAG, "No events today, skipping notification");
                return Result.success();
            }

            // Show daily summary notification
            NotificationHelper.showDailySummaryNotification(
                    getApplicationContext(), todaysEvents);

            Log.d(TAG, "Daily summary notification shown");
            return Result.success();

        } catch (Exception e) {
            Log.e(TAG, "Failed to show daily summary", e);
            return Result.retry();
        }
    }

    /**
     * Fetch today's events from the scheduler's cache or API.
     */
    private List<Event> fetchTodaysEvents() {
        // Reuse NotificationScheduler's fetch logic
        SimpleDateFormat dateFormat = new SimpleDateFormat("yyyy-MM-dd", Locale.US);
        String today = dateFormat.format(new Date());

        try {
            SharedPreferences prefs = getApplicationContext()
                    .getSharedPreferences("OrgCalendar", Context.MODE_PRIVATE);
            String serverUrl = prefs.getString("server_url", "http://192.168.1.100:8766");

            List<Event> events = NotificationScheduler.fetchEventsForDate(serverUrl, today);

            // Filter by user preferences
            List<Event> filteredEvents = new ArrayList<>();
            boolean orgEnabled = prefs.getBoolean("org_notifications_enabled", true);
            boolean icsEnabled = prefs.getBoolean("ics_notifications_enabled", true);

            for (Event event : events) {
                if (event.isOrgMode() && orgEnabled) {
                    filteredEvents.add(event);
                } else if (event.isICS() && icsEnabled) {
                    filteredEvents.add(event);
                }
            }

            return filteredEvents;
        } catch (Exception e) {
            Log.e(TAG, "Failed to fetch today's events", e);
            return new ArrayList<>();
        }
    }

    /**
     * Schedule daily summary worker.
     */
    public static void scheduleDaily(Context context) {
        // Get configured time
        SharedPreferences prefs = context.getSharedPreferences("OrgCalendar", Context.MODE_PRIVATE);
        String timeString = prefs.getString("daily_summary_time", "08:00");

        // Parse time
        String[] parts = timeString.split(":");
        int targetHour = Integer.parseInt(parts[0]);
        int targetMinute = Integer.parseInt(parts[1]);

        // Calculate delay until next occurrence
        Calendar now = Calendar.getInstance();
        Calendar target = Calendar.getInstance();
        target.set(Calendar.HOUR_OF_DAY, targetHour);
        target.set(Calendar.MINUTE, targetMinute);
        target.set(Calendar.SECOND, 0);

        // If target time already passed today, schedule for tomorrow
        if (target.before(now)) {
            target.add(Calendar.DAY_OF_MONTH, 1);
        }

        long delayMillis = target.getTimeInMillis() - now.getTimeInMillis();

        // Create periodic work request (runs daily)
        PeriodicWorkRequest workRequest = new PeriodicWorkRequest.Builder(
                DailySummaryWorker.class,
                24, TimeUnit.HOURS, // Repeat every 24 hours
                15, TimeUnit.MINUTES // Flex time window
        )
                .setInitialDelay(delayMillis, TimeUnit.MILLISECONDS)
                .build();

        // Enqueue work (replace existing)
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                WORK_NAME,
                ExistingPeriodicWorkPolicy.REPLACE,
                workRequest
        );

        Log.d(TAG, "Scheduled daily summary for " + timeString +
                   " (next in " + (delayMillis / 1000 / 60) + " minutes)");
    }

    /**
     * Cancel daily summary worker.
     */
    public static void cancelDaily(Context context) {
        WorkManager.getInstance(context).cancelUniqueWork(WORK_NAME);
        Log.d(TAG, "Canceled daily summary");
    }
}
