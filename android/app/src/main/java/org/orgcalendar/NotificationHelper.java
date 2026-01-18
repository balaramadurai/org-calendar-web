package org.orgcalendar;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import java.util.List;

/**
 * Helper class for creating and managing notifications.
 * Handles notification channels, building notifications with actions, and managing notification IDs.
 */
public class NotificationHelper {

    // Notification channel IDs
    public static final String CHANNEL_EVENT_NOTIFICATIONS = "event_notifications";
    public static final String CHANNEL_DAILY_SUMMARY = "daily_summary";

    // Notification IDs
    private static final int BASE_EVENT_NOTIFICATION_ID = 1000;
    private static final int DAILY_SUMMARY_NOTIFICATION_ID = 999;

    /**
     * Create notification channels for Android O+.
     * Must be called before showing any notifications.
     */
    public static void createNotificationChannels(Context context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager manager = context.getSystemService(NotificationManager.class);

            // Event notifications channel (high importance for timely reminders)
            NotificationChannel eventChannel = new NotificationChannel(
                    CHANNEL_EVENT_NOTIFICATIONS,
                    context.getString(R.string.notification_channel_events),
                    NotificationManager.IMPORTANCE_HIGH
            );
            eventChannel.setDescription("Notifications for upcoming events and tasks");
            eventChannel.enableVibration(true);
            eventChannel.enableLights(true);
            manager.createNotificationChannel(eventChannel);

            // Daily summary channel (default importance)
            NotificationChannel summaryChannel = new NotificationChannel(
                    CHANNEL_DAILY_SUMMARY,
                    context.getString(R.string.notification_channel_summary),
                    NotificationManager.IMPORTANCE_DEFAULT
            );
            summaryChannel.setDescription("Daily summary of your events");
            summaryChannel.enableVibration(false);
            manager.createNotificationChannel(summaryChannel);
        }
    }

    /**
     * Show notification for an upcoming event.
     *
     * @param context Application context
     * @param event Event to notify about
     * @param leadTimeMinutes Minutes before event (for display)
     */
    public static void showEventNotification(Context context, Event event, int leadTimeMinutes) {
        String timeInfo;
        if (event.allDay) {
            timeInfo = "Today";
        } else {
            timeInfo = String.format("in %d minutes at %s", leadTimeMinutes, event.getDisplayTime());
        }

        String contentText;
        if (event.isOrgMode() && event.state != null && !event.state.isEmpty()) {
            contentText = String.format("%s • %s", event.state, timeInfo);
        } else {
            contentText = timeInfo;
        }

        // Build notification
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_EVENT_NOTIFICATIONS)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(event.title)
                .setContentText(contentText)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_EVENT)
                .setAutoCancel(true)
                .setContentIntent(getOpenAppIntent(context, event));

        // Add event details to big text style
        if (event.description != null && !event.description.isEmpty()) {
            builder.setStyle(new NotificationCompat.BigTextStyle()
                    .bigText(event.description)
                    .setBigContentTitle(event.title)
                    .setSummaryText(contentText));
        }

        // Add category/calendar name as subtext
        if (event.isICS() && event.icsCalendar != null) {
            builder.setSubText(event.icsCalendar);
        } else if (event.isOrgMode() && event.category != null) {
            builder.setSubText(event.category);
        }

        // Add action buttons
        builder.addAction(getMarkDoneAction(context, event));
        builder.addAction(getOpenCalendarAction(context, event));

        // Show notification
        int notificationId = getNotificationId(event);
        NotificationManagerCompat notificationManager = NotificationManagerCompat.from(context);
        notificationManager.notify(notificationId, builder.build());
    }

    /**
     * Show daily summary notification with list of events.
     *
     * @param context Application context
     * @param events List of events for the day
     */
    public static void showDailySummaryNotification(Context context, List<Event> events) {
        if (events == null || events.isEmpty()) {
            return; // Don't show summary if no events
        }

        String title = context.getString(R.string.daily_summary_title);
        String contentText = String.format("%d events today", events.size());

        // Build inbox style for multiple events
        NotificationCompat.InboxStyle inboxStyle = new NotificationCompat.InboxStyle()
                .setBigContentTitle(title)
                .setSummaryText(contentText);

        // Add up to 7 events to the inbox
        int displayCount = Math.min(events.size(), 7);
        for (int i = 0; i < displayCount; i++) {
            Event event = events.get(i);
            String line;
            if (event.allDay) {
                line = event.title + " (All day)";
            } else {
                line = event.time + " - " + event.title;
            }
            inboxStyle.addLine(line);
        }

        if (events.size() > 7) {
            inboxStyle.addLine(String.format("...and %d more", events.size() - 7));
        }

        // Build notification
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_DAILY_SUMMARY)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(title)
                .setContentText(contentText)
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                .setCategory(NotificationCompat.CATEGORY_EVENT)
                .setStyle(inboxStyle)
                .setAutoCancel(true)
                .setContentIntent(getOpenAppIntent(context, null));

        // Show notification
        NotificationManagerCompat notificationManager = NotificationManagerCompat.from(context);
        notificationManager.notify(DAILY_SUMMARY_NOTIFICATION_ID, builder.build());
    }

    /**
     * Dismiss a specific event notification.
     */
    public static void dismissNotification(Context context, Event event) {
        int notificationId = getNotificationId(event);
        NotificationManagerCompat notificationManager = NotificationManagerCompat.from(context);
        notificationManager.cancel(notificationId);
    }

    /**
     * Get notification ID for an event (stable hash of event key).
     */
    private static int getNotificationId(Event event) {
        // Use hash of event key to generate stable notification ID
        int hash = event.getKey().hashCode();
        // Ensure it's in our range and positive
        return BASE_EVENT_NOTIFICATION_ID + (Math.abs(hash) % 9000);
    }

    /**
     * Create "Mark Done" action for notification.
     */
    private static NotificationCompat.Action getMarkDoneAction(Context context, Event event) {
        Intent intent = new Intent(context, NotificationActionReceiver.class);
        intent.setAction(NotificationActionReceiver.ACTION_MARK_DONE);
        intent.putExtra("event", event);

        PendingIntent pendingIntent = PendingIntent.getBroadcast(
                context,
                getNotificationId(event),
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        return new NotificationCompat.Action.Builder(
                0, // No icon for action
                context.getString(R.string.action_mark_done),
                pendingIntent
        ).build();
    }

    /**
     * Create "Open Calendar" action for notification.
     */
    private static NotificationCompat.Action getOpenCalendarAction(Context context, Event event) {
        Intent intent = new Intent(context, NotificationActionReceiver.class);
        intent.setAction(NotificationActionReceiver.ACTION_OPEN_CALENDAR);
        intent.putExtra("event", event);

        PendingIntent pendingIntent = PendingIntent.getBroadcast(
                context,
                getNotificationId(event) + 1, // Different request code
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        return new NotificationCompat.Action.Builder(
                0, // No icon for action
                context.getString(R.string.action_open_calendar),
                pendingIntent
        ).build();
    }

    /**
     * Create intent to open main app.
     */
    private static PendingIntent getOpenAppIntent(Context context, Event event) {
        Intent intent = new Intent(context, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        if (event != null) {
            intent.putExtra("event", event);
        }

        return PendingIntent.getActivity(
                context,
                event != null ? getNotificationId(event) + 2 : 0,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }
}
