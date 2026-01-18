package org.orgcalendar;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.util.Log;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.reflect.TypeToken;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.Date;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Schedules and manages notification alarms for upcoming events.
 * Uses AlarmManager for precise timing and fetches events from backend API.
 */
public class NotificationScheduler {
    private static final String TAG = "NotificationScheduler";
    private static final String PREFS_NAME = "OrgCalendar";
    private static final String PREF_LAST_NOTIFICATION_TIMES = "last_notification_times";
    private static final String PREF_CACHED_EVENTS = "cached_events";
    private static final String PREF_CACHE_TIMESTAMP = "cache_timestamp";

    // Preference keys
    private static final String PREF_NOTIFICATION_ENABLED = "notification_enabled";
    private static final String PREF_ORG_NOTIFICATIONS = "org_notifications_enabled";
    private static final String PREF_ICS_NOTIFICATIONS = "ics_notifications_enabled";
    private static final String PREF_LEAD_TIME = "notification_lead_time";
    private static final String PREF_SERVER_URL = "server_url";

    /**
     * Main entry point for scheduling notifications.
     * Call this when settings change, after showing a notification, or on app startup.
     */
    public static void scheduleNextAlarm(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);

        // Check if notifications are enabled
        if (!prefs.getBoolean(PREF_NOTIFICATION_ENABLED, false)) {
            Log.d(TAG, "Notifications disabled, canceling all alarms");
            cancelAllAlarms(context);
            return;
        }

        // Fetch events from API
        List<Event> upcomingEvents = fetchUpcomingEvents(context);
        if (upcomingEvents.isEmpty()) {
            Log.d(TAG, "No upcoming events found");
            return;
        }

        // Find next event to notify
        Event nextEvent = findNextEventToNotify(context, upcomingEvents, prefs);
        if (nextEvent == null) {
            Log.d(TAG, "No events need notification");
            return;
        }

        // Calculate notification time
        int leadTimeMinutes = Integer.parseInt(prefs.getString(PREF_LEAD_TIME, "15"));
        long notificationTime = calculateNotificationTime(nextEvent, leadTimeMinutes);

        if (notificationTime <= System.currentTimeMillis()) {
            Log.d(TAG, "Notification time in past, skipping");
            return;
        }

        // Set alarm
        setAlarm(context, nextEvent, notificationTime, leadTimeMinutes);
        Log.d(TAG, "Scheduled notification for: " + nextEvent.title + " at " + new Date(notificationTime));
    }

    /**
     * Cancel all scheduled notification alarms.
     */
    public static void cancelAllAlarms(Context context) {
        AlarmManager alarmManager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        Intent intent = new Intent(context, AlarmReceiver.class);
        PendingIntent pendingIntent = PendingIntent.getBroadcast(
                context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        alarmManager.cancel(pendingIntent);
        Log.d(TAG, "Canceled all alarms");
    }

    /**
     * Fetch events for today and tomorrow from backend API.
     */
    private static List<Event> fetchUpcomingEvents(Context context) {
        List<Event> events = new ArrayList<>();
        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        String serverUrl = prefs.getString(PREF_SERVER_URL, "http://192.168.1.100:8766");

        // Get today and tomorrow dates
        SimpleDateFormat dateFormat = new SimpleDateFormat("yyyy-MM-dd", Locale.US);
        Calendar cal = Calendar.getInstance();
        String today = dateFormat.format(cal.getTime());
        cal.add(Calendar.DAY_OF_MONTH, 1);
        String tomorrow = dateFormat.format(cal.getTime());

        try {
            // Fetch today's events
            events.addAll(fetchEventsForDate(serverUrl, today));
            // Fetch tomorrow's events
            events.addAll(fetchEventsForDate(serverUrl, tomorrow));

            // Cache events for offline use
            cacheEvents(context, events);

            Log.d(TAG, "Fetched " + events.size() + " events from API");
        } catch (Exception e) {
            Log.e(TAG, "Failed to fetch events from API", e);
            // Try to use cached events
            events = loadCachedEvents(context);
            Log.d(TAG, "Using " + events.size() + " cached events");
        }

        return events;
    }

    /**
     * Fetch events for a specific date from the API.
     */
    public static List<Event> fetchEventsForDate(String serverUrl, String date) throws Exception {
        List<Event> events = new ArrayList<>();
        String urlString = serverUrl + "/events/" + date;

        URL url = new URL(urlString);
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setRequestMethod("GET");
        conn.setConnectTimeout(5000);
        conn.setReadTimeout(5000);

        int responseCode = conn.getResponseCode();
        if (responseCode == HttpURLConnection.HTTP_OK) {
            BufferedReader reader = new BufferedReader(new InputStreamReader(conn.getInputStream()));
            StringBuilder response = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) {
                response.append(line);
            }
            reader.close();

            // Parse JSON response
            Gson gson = new Gson();
            JsonObject jsonObject = gson.fromJson(response.toString(), JsonObject.class);

            // Response format: {"events": {"2026-01-11": [...], ...}}
            if (jsonObject.has("events")) {
                JsonObject eventsObj = jsonObject.getAsJsonObject("events");
                if (eventsObj.has(date)) {
                    JsonArray eventArray = eventsObj.getAsJsonArray(date);
                    events = parseEventArray(eventArray, date);
                }
            }
        } else {
            throw new Exception("HTTP " + responseCode);
        }

        conn.disconnect();
        return events;
    }

    /**
     * Parse JSON array of events into Event objects.
     */
    private static List<Event> parseEventArray(JsonArray eventArray, String date) {
        List<Event> events = new ArrayList<>();

        for (JsonElement element : eventArray) {
            try {
                JsonObject eventObj = element.getAsJsonObject();
                Event event = new Event();

                event.title = getJsonString(eventObj, "title");
                event.date = date;
                event.time = getJsonString(eventObj, "time");
                event.endTime = getJsonString(eventObj, "end_time");
                event.state = getJsonString(eventObj, "state");
                event.category = getJsonString(eventObj, "category");
                event.color = getJsonString(eventObj, "color");
                event.source = getJsonString(eventObj, "source");
                event.icsCalendar = getJsonString(eventObj, "ics_calendar");
                event.uid = getJsonString(eventObj, "uid");
                event.file = getJsonString(eventObj, "file");
                event.description = getJsonString(eventObj, "description");

                if (eventObj.has("line")) {
                    event.line = eventObj.get("line").getAsInt();
                }

                // Check if all-day event
                event.allDay = (event.time == null || event.time.isEmpty());

                events.add(event);
            } catch (Exception e) {
                Log.w(TAG, "Failed to parse event", e);
            }
        }

        return events;
    }

    /**
     * Helper to safely get string from JSON object.
     */
    private static String getJsonString(JsonObject obj, String key) {
        if (obj.has(key) && !obj.get(key).isJsonNull()) {
            return obj.get(key).getAsString();
        }
        return null;
    }

    /**
     * Find the next event that needs notification.
     */
    private static Event findNextEventToNotify(Context context, List<Event> events, SharedPreferences prefs) {
        int leadTimeMinutes = Integer.parseInt(prefs.getString(PREF_LEAD_TIME, "15"));
        long currentTime = System.currentTimeMillis();
        Event nextEvent = null;
        long nextNotificationTime = Long.MAX_VALUE;

        for (Event event : events) {
            // Check if should notify for this event
            if (!shouldNotify(event, prefs)) {
                continue;
            }

            // Skip all-day events (handle in daily summary)
            if (event.allDay) {
                continue;
            }

            // Calculate notification time
            long notificationTime = calculateNotificationTime(event, leadTimeMinutes);

            // Skip if in the past or more than 1 hour past
            if (notificationTime < currentTime - (60 * 60 * 1000)) {
                continue;
            }

            // Skip if already notified recently
            if (wasRecentlyNotified(context, event, leadTimeMinutes)) {
                continue;
            }

            // Find earliest notification
            if (notificationTime < nextNotificationTime && notificationTime > currentTime) {
                nextNotificationTime = notificationTime;
                nextEvent = event;
            }
        }

        return nextEvent;
    }

    /**
     * Check if event should trigger notification based on user preferences.
     */
    private static boolean shouldNotify(Event event, SharedPreferences prefs) {
        boolean orgEnabled = prefs.getBoolean(PREF_ORG_NOTIFICATIONS, true);
        boolean icsEnabled = prefs.getBoolean(PREF_ICS_NOTIFICATIONS, true);

        if (event.isOrgMode() && !orgEnabled) {
            return false;
        }

        if (event.isICS() && !icsEnabled) {
            return false;
        }

        // Could add per-calendar filtering here for ICS calendars
        // For now, treat all ICS calendars the same

        return true;
    }

    /**
     * Calculate when to show notification for an event.
     */
    private static long calculateNotificationTime(Event event, int leadTimeMinutes) {
        try {
            // Parse date and time
            SimpleDateFormat dateFormat = new SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.US);
            String dateTimeString = event.date + " " + event.time;
            Date eventTime = dateFormat.parse(dateTimeString);

            if (eventTime != null) {
                // Subtract lead time
                return eventTime.getTime() - (leadTimeMinutes * 60 * 1000L);
            }
        } catch (Exception e) {
            Log.e(TAG, "Failed to parse event time", e);
        }

        return System.currentTimeMillis();
    }

    /**
     * Check if event was recently notified to avoid duplicates.
     */
    private static boolean wasRecentlyNotified(Context context, Event event, int leadTimeMinutes) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        String lastNotifJson = prefs.getString(PREF_LAST_NOTIFICATION_TIMES, "{}");

        try {
            Gson gson = new Gson();
            Map<String, Long> lastNotificationTimes = gson.fromJson(
                    lastNotifJson, new TypeToken<Map<String, Long>>(){}.getType());

            String eventKey = event.getKey();
            if (lastNotificationTimes.containsKey(eventKey)) {
                long lastNotifTime = lastNotificationTimes.get(eventKey);
                long now = System.currentTimeMillis();
                // Don't notify again if notified within (leadTime + 5 minutes)
                long threshold = (leadTimeMinutes + 5) * 60 * 1000L;
                return (now - lastNotifTime) < threshold;
            }
        } catch (Exception e) {
            Log.e(TAG, "Failed to check last notification times", e);
        }

        return false;
    }

    /**
     * Record that we notified for an event.
     */
    public static void recordNotification(Context context, Event event) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        String lastNotifJson = prefs.getString(PREF_LAST_NOTIFICATION_TIMES, "{}");

        try {
            Gson gson = new Gson();
            Map<String, Long> lastNotificationTimes = gson.fromJson(
                    lastNotifJson, new TypeToken<Map<String, Long>>(){}.getType());

            if (lastNotificationTimes == null) {
                lastNotificationTimes = new HashMap<>();
            }

            lastNotificationTimes.put(event.getKey(), System.currentTimeMillis());

            // Clean up old entries (older than 24 hours)
            long dayAgo = System.currentTimeMillis() - (24 * 60 * 60 * 1000L);
            lastNotificationTimes.entrySet().removeIf(entry -> entry.getValue() < dayAgo);

            String updatedJson = gson.toJson(lastNotificationTimes);
            prefs.edit().putString(PREF_LAST_NOTIFICATION_TIMES, updatedJson).apply();
        } catch (Exception e) {
            Log.e(TAG, "Failed to record notification", e);
        }
    }

    /**
     * Set alarm for event notification.
     */
    private static void setAlarm(Context context, Event event, long notificationTime, int leadTimeMinutes) {
        AlarmManager alarmManager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);

        Intent intent = new Intent(context, AlarmReceiver.class);
        intent.putExtra("event", event);
        intent.putExtra("lead_time", leadTimeMinutes);

        PendingIntent pendingIntent = PendingIntent.getBroadcast(
                context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        // Use exact alarm that can wake device from Doze mode
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            alarmManager.setExactAndAllowWhileIdle(
                    AlarmManager.RTC_WAKEUP, notificationTime, pendingIntent);
        } else {
            alarmManager.setExact(AlarmManager.RTC_WAKEUP, notificationTime, pendingIntent);
        }
    }

    /**
     * Cache events for offline use.
     */
    private static void cacheEvents(Context context, List<Event> events) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        Gson gson = new Gson();
        String json = gson.toJson(events);
        prefs.edit()
                .putString(PREF_CACHED_EVENTS, json)
                .putLong(PREF_CACHE_TIMESTAMP, System.currentTimeMillis())
                .apply();
    }

    /**
     * Load cached events.
     */
    private static List<Event> loadCachedEvents(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        String json = prefs.getString(PREF_CACHED_EVENTS, "[]");

        try {
            Gson gson = new Gson();
            return gson.fromJson(json, new TypeToken<List<Event>>(){}.getType());
        } catch (Exception e) {
            Log.e(TAG, "Failed to load cached events", e);
            return new ArrayList<>();
        }
    }
}
