package org.orgcalendar;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.widget.RemoteViews;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * Widget provider for Org Calendar events.
 * Shows today's events from the configured server.
 */
public class CalendarWidget extends AppWidgetProvider {

    public static final String ACTION_REFRESH = "org.orgcalendar.ACTION_REFRESH";
    public static final String ACTION_OPEN_APP = "org.orgcalendar.ACTION_OPEN_APP";
    private static final String PREF_SERVER_URL = "server_url";

    @Override
    public void onUpdate(Context context, AppWidgetManager appWidgetManager, int[] appWidgetIds) {
        for (int appWidgetId : appWidgetIds) {
            updateAppWidget(context, appWidgetManager, appWidgetId);
        }
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        super.onReceive(context, intent);

        if (ACTION_REFRESH.equals(intent.getAction())) {
            // Force refresh all widgets
            AppWidgetManager appWidgetManager = AppWidgetManager.getInstance(context);
            ComponentName thisWidget = new ComponentName(context, CalendarWidget.class);
            int[] appWidgetIds = appWidgetManager.getAppWidgetIds(thisWidget);
            
            // Notify the widget service to refresh data
            appWidgetManager.notifyAppWidgetViewDataChanged(appWidgetIds, R.id.widget_events_list);
            
            // Update the widgets
            onUpdate(context, appWidgetManager, appWidgetIds);
        } else if (ACTION_OPEN_APP.equals(intent.getAction())) {
            // Open main app
            Intent launchIntent = new Intent(context, MainActivity.class);
            launchIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(launchIntent);
        }
    }

    static void updateAppWidget(Context context, AppWidgetManager appWidgetManager, int appWidgetId) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_calendar);

        // Set today's date
        SimpleDateFormat sdf = new SimpleDateFormat("EEEE, MMM d", Locale.getDefault());
        views.setTextViewText(R.id.widget_date, sdf.format(new Date()));

        // Set up refresh button
        Intent refreshIntent = new Intent(context, CalendarWidget.class);
        refreshIntent.setAction(ACTION_REFRESH);
        PendingIntent refreshPendingIntent = PendingIntent.getBroadcast(
                context, 0, refreshIntent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        views.setOnClickPendingIntent(R.id.widget_refresh, refreshPendingIntent);

        // Set up click on widget to open app
        Intent openAppIntent = new Intent(context, MainActivity.class);
        openAppIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent openAppPendingIntent = PendingIntent.getActivity(
                context, 0, openAppIntent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        views.setOnClickPendingIntent(R.id.widget_date, openAppPendingIntent);

        // Set up the list adapter
        Intent serviceIntent = new Intent(context, CalendarWidgetService.class);
        serviceIntent.putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId);
        serviceIntent.setData(Uri.parse(serviceIntent.toUri(Intent.URI_INTENT_SCHEME)));
        views.setRemoteAdapter(R.id.widget_events_list, serviceIntent);

        // Set empty view
        views.setEmptyView(R.id.widget_events_list, R.id.widget_empty);

        // Set up click on list item to open app
        views.setPendingIntentTemplate(R.id.widget_events_list, openAppPendingIntent);

        appWidgetManager.updateAppWidget(appWidgetId, views);
    }

    @Override
    public void onEnabled(Context context) {
        // First widget added
    }

    @Override
    public void onDisabled(Context context) {
        // Last widget removed
    }

    /**
     * Get the server URL from shared preferences.
     */
    public static String getServerUrl(Context context) {
        SharedPreferences prefs = context.getSharedPreferences("OrgCalendar", Context.MODE_PRIVATE);
        return prefs.getString(PREF_SERVER_URL, null);
    }

    /**
     * Trigger widget update from external components (e.g., notification actions).
     * This refreshes the widget data to reflect changes like marking events as done.
     */
    public static void triggerUpdate(Context context) {
        Intent intent = new Intent(context, CalendarWidget.class);
        intent.setAction(ACTION_REFRESH);
        context.sendBroadcast(intent);
    }
}
