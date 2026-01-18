package org.orgcalendar;

import java.io.Serializable;

/**
 * Event data model representing both ICS calendar events and org-mode tasks.
 * Used for passing event data between components and in notification extras.
 */
public class Event implements Serializable {
    private static final long serialVersionUID = 1L;

    // Basic event information
    public String title;
    public String date;        // YYYY-MM-DD format
    public String time;        // HH:mm format (24-hour)
    public String endTime;     // HH:mm format (24-hour)

    // Org-mode specific fields
    public String state;       // TODO, DONE, NEXT, WAITING, CANCELLED, etc.
    public String category;
    public String color;

    // Source identification
    public String source;      // "org" or "ics"
    public String icsCalendar; // Calendar name for ICS events

    // Unique identifiers
    public String uid;         // Unique ID for ICS events
    public String file;        // File path for org-mode events
    public int line;           // Line number for org-mode events

    // Additional fields
    public boolean allDay;     // True if event is all-day
    public String description; // Event description/notes

    /**
     * Get a unique key for this event, used for deduplication and tracking.
     */
    public String getKey() {
        if ("ics".equals(source) && uid != null && icsCalendar != null) {
            return icsCalendar + ":" + uid + ":" + date;
        } else if ("org".equals(source) && file != null) {
            return "org:" + file + ":" + line;
        }
        // Fallback to title+date+time
        return source + ":" + title + ":" + date + ":" + time;
    }

    /**
     * Get display time string for the event.
     */
    public String getDisplayTime() {
        if (allDay) {
            return "All day";
        }
        if (time != null && endTime != null) {
            return time + " - " + endTime;
        }
        if (time != null) {
            return time;
        }
        return "";
    }

    /**
     * Check if this event is from an org-mode source.
     */
    public boolean isOrgMode() {
        return "org".equals(source);
    }

    /**
     * Check if this event is from an ICS calendar.
     */
    public boolean isICS() {
        return "ics".equals(source);
    }

    @Override
    public String toString() {
        return "Event{" +
                "title='" + title + '\'' +
                ", date='" + date + '\'' +
                ", time='" + time + '\'' +
                ", source='" + source + '\'' +
                ", key='" + getKey() + '\'' +
                '}';
    }
}
