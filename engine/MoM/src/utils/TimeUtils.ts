export function getNextCmeOpen(): Date {
    const now = new Date();
    // Use America/New_York timezone for CME logic
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        year: 'numeric', month: 'numeric', day: 'numeric',
        hour: 'numeric', minute: 'numeric', second: 'numeric',
        hour12: false,
    });
    
    // Parse current ET time
    const parts = formatter.formatToParts(now);
    const nyMap: any = {};
    for (const p of parts) nyMap[p.type] = parseInt(p.value, 10) || p.value;
    
    const nyDate = new Date(nyMap.year, nyMap.month - 1, nyMap.day, nyMap.hour, nyMap.minute, nyMap.second);
    
    let nextOpen = new Date(nyDate);
    
    // CME reopens at 18:00 ET (6:00 PM) Sunday - Thursday
    // If it's before 18:00 today, the next open is today at 18:00
    // If it's after 18:00 today, the next open is tomorrow at 18:00
    if (nyDate.getHours() >= 18 && (nyDate.getHours() > 18 || nyDate.getMinutes() >= 15)) {
        nextOpen.setDate(nextOpen.getDate() + 1);
    }
    
    // Set to 18:15 ET (6:15 PM)
    nextOpen.setHours(18, 15, 0, 0);

    // If next open falls on a Friday (5) or Saturday (6), push to Sunday (0)
    if (nextOpen.getDay() === 5) nextOpen.setDate(nextOpen.getDate() + 2); // Friday -> Sunday
    else if (nextOpen.getDay() === 6) nextOpen.setDate(nextOpen.getDate() + 1); // Saturday -> Sunday

    // Return the absolute Date object (which Node handles in local time, but represents the exact ET timestamp)
    // We must convert the NY time representation back to UTC for standard Date object usage.
    // The easiest way is to construct an ISO string with the ET offset (-05:00 or -04:00).
    // But since node cron / timeout is relative, we can just calculate milliseconds until next open.
    
    // A more robust method using purely Date math:
    const nyTimeOffset = parseInt(new Intl.DateTimeFormat('en-US', {timeZone: 'America/New_York', timeZoneName: 'shortOffset'}).format(now).split('GMT')[1].split(':')[0]);
    
    const utcDate = new Date(Date.UTC(
        nextOpen.getFullYear(), nextOpen.getMonth(), nextOpen.getDate(),
        nextOpen.getHours() - nyTimeOffset, 0, 0, 0
    ));
    
    return utcDate;
}
