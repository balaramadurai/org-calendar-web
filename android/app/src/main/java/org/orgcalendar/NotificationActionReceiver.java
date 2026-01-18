package org.orgcalendar;

import android.content.BroadcastReceiver;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.AsyncTask;
import android.provider.CalendarContract;
import android.util.Log;
import android.widget.Toast;

import com.google.gson.Gson;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.text.SimpleDateFormat;
import java.util.Calendar;
import java.util.Date;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.TimeZone;

/**
 * Handles notification action button taps (Mark Done, Open Calendar).
 * Performs API calls and interacts with Android's Calendar provider.
 */
public class NotificationActionReceiver extends BroadcastReceiver {
    private static final String TAG = "NotificationAction";
    private static final String PREFS_NAME = "OrgCalendar";
    private static final String PREF_SERVER_URL = "server_url";
    private static final String PREF_ICS_DONE_EVENTS = "ics_done_events";

    public static final String ACTION_MARK_DONE = "org.orgcalendar.MARK_DONE";
    public static final String ACTION_OPEN_CALENDAR = "org.orgcalendar.OPEN_CALENDAR";

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        Event event = (Event) intent.getSerializableExtra("event");

        if (event == null) {
            Log.e(TAG, "No event in action intent");
            return;
        }

        Log.d(TAG, "Action: " + action + " for event: " + event.title);

        if (ACTION_MARK_DONE.equals(action)) {
            handleMarkDone(context, event);
        } else if (ACTION_OPEN_CALENDAR.equals(action)) {
            handleOpenCalendar(context, event);
        }
    }

    /**
     * Handle "Mark Done" action.
     */
    private void handleMarkDone(Context context, Event event) {
        // Dismiss notification immediately for better UX
        NotificationHelper.dismissNotification(context, event);

        if (event.isOrgMode()) {
            markOrgModeDone(context, event);
        } else if (event.isICS()) {
            markICSEventDone(context, event);
        }
    }

    /**
     * Mark org-mode event as done via API.
     */
    private void markOrgModeDone(Context context, Event event) {
        new AsyncTask<Void, Void, Boolean>() {
            @Override
            protected Boolean doInBackground(Void... voids) {
                try {
                    SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
                    String serverUrl = prefs.getString(PREF_SERVER_URL, "http://192.168.1.100:8766");

                    // Build request
                    URL url = new URL(serverUrl + "/events/done");
                    HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                    conn.setRequestMethod("POST");
                    conn.setRequestProperty("Content-Type", "application/json");
                    conn.setDoOutput(true);
                    conn.setConnectTimeout(5000);
                    conn.setReadTimeout(5000);

                    // Create JSON body
                    String jsonBody = String.format(
                            "{\"file\":\"%s\",\"line\":%d}",
                            event.file, event.line
                    );

                    // Send request
                    OutputStream os = conn.getOutputStream();
                    os.write(jsonBody.getBytes());
                    os.flush();
                    os.close();

                    int responseCode = conn.getResponseCode();
                    conn.disconnect();

                    return responseCode == HttpURLConnection.HTTP_OK;
                } catch (Exception e) {
                    Log.e(TAG, "Failed to mark org-mode event done", e);
                    return false;
                }
            }

            @Override
            protected void onPostExecute(Boolean success) {
                if (success) {
                    Toast.makeText(context, context.getString(R.string.event_marked_done), Toast.LENGTH_SHORT).show();
                    // Update widget if needed
                    CalendarWidget.triggerUpdate(context);
                } else {
                    Toast.makeText(context, "Failed to mark event done", Toast.LENGTH_SHORT).show();
                }
            }
        }.execute();
    }

    /**
     * Mark ICS event as done (local storage + API sync).
     */
    private void markICSEventDone(Context context, Event event) {
        // Save to local storage immediately
        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        Set<String> doneEvents = prefs.getStringSet(PREF_ICS_DONE_EVENTS, new HashSet<>());
        // Need to create new set to modify (SharedPreferences returns unmodifiable set)
        doneEvents = new HashSet<>(doneEvents);
        doneEvents.add(event.getKey());
        prefs.edit().putStringSet(PREF_ICS_DONE_EVENTS, doneEvents).apply();

        // Sync to server in background
        new AsyncTask<Void, Void, Boolean>() {
            @Override
            protected Boolean doInBackground(Void... voids) {
                try {
                    SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
                    String serverUrl = prefs.getString(PREF_SERVER_URL, "http://192.168.1.100:8766");

                    URL url = new URL(serverUrl + "/api/ics/mark-done");
                    HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                    conn.setRequestMethod("POST");
                    conn.setRequestProperty("Content-Type", "application/json");
                    conn.setDoOutput(true);
                    conn.setConnectTimeout(5000);
                    conn.setReadTimeout(5000);

                    // Create JSON body with timestamp
                    SimpleDateFormat isoFormat = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US);
                    isoFormat.setTimeZone(TimeZone.getTimeZone("UTC"));
                    String timestamp = isoFormat.format(new Date());

                    String jsonBody = String.format(
                            "{\"uid\":\"%s\",\"calendar\":\"%s\",\"timestamp\":\"%s\"}",
                            event.uid != null ? event.uid : "",
                            event.icsCalendar != null ? event.icsCalendar : "",
                            timestamp
                    );

                    // Send request
                    OutputStream os = conn.getOutputStream();
                    os.write(jsonBody.getBytes());
                    os.flush();
                    os.close();

                    int responseCode = conn.getResponseCode();
                    conn.disconnect();

                    return responseCode == HttpURLConnection.HTTP_OK;
                } catch (Exception e) {
                    Log.e(TAG, "Failed to sync ICS done status to server", e);
                    // Not critical - we saved locally
                    return true; // Return true anyway since local save succeeded
                }
            }

            @Override
            protected void onPostExecute(Boolean success) {
                Toast.makeText(context, context.getString(R.string.event_marked_done), Toast.LENGTH_SHORT).show();
                // Update widget to reflect done status
                CalendarWidget.triggerUpdate(context);
            }
        }.execute();
    }

    /**
     * Handle "Open Calendar" action.
     */
    private void handleOpenCalendar(Context context, Event event) {
        // Dismiss notification
        NotificationHelper.dismissNotification(context, event);

        // Check for calendar permissions
        if (!hasCalendarPermissions(context)) {
            Toast.makeText(context, context.getString(R.string.calendar_permission_required), Toast.LENGTH_LONG).show();
            // Fall back to opening main app
            openMainApp(context, event);
            return;
        }

        // Create temporary calendar event and open
        new AsyncTask<Void, Void, Long>() {
            @Override
            protected Long doInBackground(Void... voids) {
                try {
                    return createTemporaryCalendarEvent(context, event);
                } catch (Exception e) {
                    Log.e(TAG, "Failed to create calendar event", e);
                    return null;
                }
            }

            @Override
            protected void onPostExecute(Long eventId) {
                if (eventId != null && eventId > 0) {
                    openInCalendarApp(context, eventId);
                } else {
                    Toast.makeText(context, "Failed to open calendar", Toast.LENGTH_SHORT).show();
                    openMainApp(context, event);
                }
            }
        }.execute();
    }

    /**
     * Create a temporary calendar event for viewing.
     */
    private Long createTemporaryCalendarEvent(Context context, Event event) {
        try {
            ContentValues values = new ContentValues();
            values.put(CalendarContract.Events.TITLE, event.title);

            // Parse date and time
            long startMillis = parseEventDateTime(event.date, event.time);
            long endMillis;

            if (event.endTime != null && !event.endTime.isEmpty()) {
                endMillis = parseEventDateTime(event.date, event.endTime);
            } else {
                // Default 1 hour duration
                endMillis = startMillis + (60 * 60 * 1000);
            }

            values.put(CalendarContract.Events.DTSTART, startMillis);
            values.put(CalendarContract.Events.DTEND, endMillis);
            values.put(CalendarContract.Events.EVENT_TIMEZONE, TimeZone.getDefault().getID());

            // Use primary calendar
            long calendarId = getPrimaryCalendarId(context);
            if (calendarId == -1) {
                Log.e(TAG, "No calendar found");
                return null;
            }
            values.put(CalendarContract.Events.CALENDAR_ID, calendarId);

            // Add description if available
            if (event.description != null && !event.description.isEmpty()) {
                values.put(CalendarContract.Events.DESCRIPTION, event.description);
            }

            // Mark as temporary (can be deleted)
            values.put(CalendarContract.Events.ACCESS_LEVEL, CalendarContract.Events.ACCESS_PUBLIC);
            values.put(CalendarContract.Events.AVAILABILITY, CalendarContract.Events.AVAILABILITY_BUSY);

            // Insert event
            Uri uri = context.getContentResolver().insert(CalendarContract.Events.CONTENT_URI, values);
            if (uri != null) {
                return Long.parseLong(uri.getLastPathSegment());
            }
        } catch (Exception e) {
            Log.e(TAG, "Failed to create calendar event", e);
        }

        return null;
    }

    /**
     * Parse event date and time to milliseconds.
     */
    private long parseEventDateTime(String date, String time) throws Exception {
        SimpleDateFormat format;
        String dateTimeString;

        if (time != null && !time.isEmpty()) {
            format = new SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.US);
            dateTimeString = date + " " + time;
        } else {
            format = new SimpleDateFormat("yyyy-MM-dd", Locale.US);
            dateTimeString = date;
        }

        Date parsed = format.parse(dateTimeString);
        return parsed != null ? parsed.getTime() : System.currentTimeMillis();
    }

    /**
     * Get primary calendar ID.
     */
    private long getPrimaryCalendarId(Context context) {
        try {
            String[] projection = new String[]{CalendarContract.Calendars._ID};
            String selection = CalendarContract.Calendars.IS_PRIMARY + " = 1";

            android.database.Cursor cursor = context.getContentResolver().query(
                    CalendarContract.Calendars.CONTENT_URI,
                    projection,
                    selection,
                    null,
                    null
            );

            if (cursor != null) {
                if (cursor.moveToFirst()) {
                    long calendarId = cursor.getLong(0);
                    cursor.close();
                    return calendarId;
                }
                cursor.close();
            }

            // If no primary calendar, get first available calendar
            cursor = context.getContentResolver().query(
                    CalendarContract.Calendars.CONTENT_URI,
                    projection,
                    null,
                    null,
                    null
            );

            if (cursor != null) {
                if (cursor.moveToFirst()) {
                    long calendarId = cursor.getLong(0);
                    cursor.close();
                    return calendarId;
                }
                cursor.close();
            }
        } catch (Exception e) {
            Log.e(TAG, "Failed to get calendar ID", e);
        }

        return -1;
    }

    /**
     * Open event in calendar app.
     */
    private void openInCalendarApp(Context context, long eventId) {
        try {
            Uri uri = ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, eventId);
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setData(uri);
            intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            context.startActivity(intent);
        } catch (Exception e) {
            Log.e(TAG, "Failed to open calendar app", e);
            Toast.makeText(context, "No calendar app found", Toast.LENGTH_SHORT).show();
        }
    }

    /**
     * Open main app as fallback.
     */
    private void openMainApp(Context context, Event event) {
        try {
            Intent intent = new Intent(context, MainActivity.class);
            intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            intent.putExtra("event", event);
            context.startActivity(intent);
        } catch (Exception e) {
            Log.e(TAG, "Failed to open main app", e);
        }
    }

    /**
     * Check if app has calendar permissions.
     */
    private boolean hasCalendarPermissions(Context context) {
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.M) {
            return context.checkSelfPermission(android.Manifest.permission.READ_CALENDAR) ==
                    android.content.pm.PackageManager.PERMISSION_GRANTED &&
                   context.checkSelfPermission(android.Manifest.permission.WRITE_CALENDAR) ==
                    android.content.pm.PackageManager.PERMISSION_GRANTED;
        }
        return true;
    }
}
