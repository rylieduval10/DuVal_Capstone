const sql = require('mssql');
const axios = require('axios');

// database configuration
const dbConfig = {
    user: 'YOUR_USERNAME',
    password: 'YOUR_PASSWORD',
    server: 'YOUR_SERVER.database.windows.net',
    database: 'basketball_data',
    port: 1433,
    options: {
        encrypt: true,
        trustServerCertificate: false,
        enableArithAbort: true
    },
    connectionTimeout: 30000,
    requestTimeout: 30000
};

// nba api credentials
const NBA_API_KEY = 'YOUR_API_KEY';
const NBA_BASE_URL = 'https://v2.nba.api-sports.io';

// normalize team names for matching
function normalizeTeamName(name) {
    const normalized = name.toLowerCase()
        .replace('la ', 'los angeles ')
        .replace('ny ', 'new york ')
        .trim();
    return normalized;
}

// logging function with timestamps
function log(message, level = 'INFO') {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${level}: ${message}`);
}

// build flexible name matching conditions for player lookups
function buildNameMatchConditions(firstName, lastName) {
    const conditions = [];
    
    // clean up names - remove suffixes for matching
    const suffixPattern = /\s*(Jr\.?|Sr\.?|II|III|IV|V)$/i;
    let cleanFirst = firstName.replace(suffixPattern, '').trim();
    let cleanLast = lastName.replace(suffixPattern, '').trim();
    
    // try without hyphens and with hyphens
    const lastNoHyphen = cleanLast.replace(/-/g, '');
    const lastWithHyphen = cleanLast.replace(/([a-z])([A-Z])/g, '$1-$2');
    
    // handle apostrophes - try both with and without
    const lastNoApostrophe = cleanLast.replace(/'/g, '');
    
    // build all variations of last name to try
    const lastNameVariations = [...new Set([
        cleanLast,
        lastNoHyphen,
        lastWithHyphen,
        lastNoApostrophe
    ])];
    
    const firstInitial = cleanFirst.charAt(0);
    
    // create sql conditions for all name variations
    for (const last of lastNameVariations) {
        const escFirst = cleanFirst.replace(/'/g, "''");
        const escLast = last.replace(/'/g, "''");
        
        // full name: "yves missi"
        conditions.push(`PlayerName LIKE '%${escFirst} ${escLast}%'`);
        conditions.push(`PlayerName LIKE '%${escFirst}%${escLast}%'`);
        
        // with suffixes in db: "michael porter jr."
        conditions.push(`PlayerName LIKE '%${escFirst} ${escLast} Jr%'`);
        conditions.push(`PlayerName LIKE '%${escFirst} ${escLast} Sr%'`);
        conditions.push(`PlayerName LIKE '%${escFirst} ${escLast} II%'`);
        conditions.push(`PlayerName LIKE '%${escFirst} ${escLast} III%'`);
        conditions.push(`PlayerName LIKE '%${escFirst} ${escLast} IV%'`);
        
        // last, first initial: "missi y" or "missi, y" or "missi y."
        conditions.push(`PlayerName LIKE '%${escLast} ${firstInitial}%'`);
        conditions.push(`PlayerName LIKE '%${escLast}, ${firstInitial}%'`);
        conditions.push(`PlayerName LIKE '${escLast} ${firstInitial}'`);
        conditions.push(`PlayerName LIKE '${escLast} ${firstInitial}.'`);
        
        // first initial. last: "y. missi"
        conditions.push(`PlayerName LIKE '%${firstInitial}. ${escLast}%'`);
        conditions.push(`PlayerName LIKE '%${firstInitial} ${escLast}%'`);
        
        // last, first: "missi, yves"
        conditions.push(`PlayerName LIKE '%${escLast}, ${escFirst}%'`);
        conditions.push(`PlayerName LIKE '%${escLast},${escFirst}%'`);
        
        // exact last name match (with gameid constraint for safety)
        conditions.push(`PlayerName LIKE '${escLast} %'`);
        conditions.push(`PlayerName LIKE '% ${escLast}'`);
        conditions.push(`PlayerName = '${escLast}'`);
    }
    
    // remove duplicates
    return [...new Set(conditions)];
}

// main function to update defensive stats for a season
async function updateDefensiveStats(season) {
    let pool;
    
    try {
        pool = await sql.connect(dbConfig);
        log(`updating defensive stats for ${season}`);
        
        // find games that need defensive stats updated
        const gamesQuery = `
    SELECT DISTINCT 
        g.Id, 
        g.APISportsId,
        g.HomeTeam,
        g.AwayTeam,
        g.StartTime
    FROM Games g
    INNER JOIN Stats s ON s.GameId = g.Id
    WHERE s.Season = '${season}'
    AND g.Status IN ('FT', 'AOT')
    AND g.StartTime >= '${season.split('-')[0]}-10-01'
    AND EXISTS (
        SELECT 1 FROM Stats 
        WHERE GameId = g.Id 
        AND Season = '${season}'
        AND (Steals = 0 OR Steals IS NULL)
    )
    ORDER BY g.StartTime`;
        
        const gamesResult = await pool.request().query(gamesQuery);
        const games = gamesResult.recordset;
        
        log(`found ${games.length} games needing defensive stats update`);
        
        if (games.length === 0) {
            log('all games already have defensive stats');
            return;
        }
        
        // initialize counters
        let successCount = 0;
        let errorCount = 0;
        let notFoundCount = 0;
        let updatedPlayers = 0;
        let unmatchedPlayers = [];
        
        // loop through each game
        for (let i = 0; i < games.length; i++) {
            const game = games[i];
            
            try {
                // rate limiting - wait 2 seconds between requests
                if (i > 0) await new Promise(resolve => setTimeout(resolve, 2000));
                
                log(`processing game ${i + 1}/${games.length}: ${game.HomeTeam} vs ${game.AwayTeam}`);

                // search for game in nba api (try dates within 7 days before/after)
                const gameDate = new Date(game.StartTime);
                const startDate = new Date(gameDate);
                startDate.setDate(startDate.getDate() - 7);
                const endDate = new Date(gameDate);
                endDate.setDate(endDate.getDate() + 7);

                let nbaGame = null;
                let foundDate = null;

                // loop through dates to find matching game
                for (let d = new Date(startDate); d <= endDate && !nbaGame; d.setDate(d.getDate() + 1)) {
                    const searchDate = d.toISOString().split('T')[0];
                    
                    try {
                        const gamesResponse = await axios.get(`${NBA_BASE_URL}/games`, {
                            headers: {
                                'x-rapidapi-key': NBA_API_KEY,
                                'x-rapidapi-host': 'v2.nba.api-sports.io'
                            },
                            params: { date: searchDate },
                            timeout: 15000
                        });
                        
                        const nbaGames = gamesResponse.data.response || [];
                        
                        // find game that matches both teams
                        nbaGame = nbaGames.find(g => {
                            const homeMatch = normalizeTeamName(g.teams.home.name) === normalizeTeamName(game.HomeTeam);
                            const awayMatch = normalizeTeamName(g.teams.visitors.name) === normalizeTeamName(game.AwayTeam);
                            return homeMatch && awayMatch;
                        });
                        
                        if (nbaGame) foundDate = searchDate;
                        await new Promise(resolve => setTimeout(resolve, 500));
                    } catch (error) {}
                }

                // if game not found in api, skip it
                if (!nbaGame) {
                    notFoundCount++;
                    log(`  matchup not found in nba api (checked 14 days)`, 'WARNING');
                    continue;
                }

                log(`  found on ${foundDate}: nba game id ${nbaGame.id}`);
                
                // wait before next api call
                await new Promise(resolve => setTimeout(resolve, 1000));
                
                // get player statistics for this game
                const statsResponse = await axios.get(`${NBA_BASE_URL}/players/statistics`, {
                    headers: {
                        'x-rapidapi-key': NBA_API_KEY,
                        'x-rapidapi-host': 'v2.nba.api-sports.io'
                    },
                    params: { game: nbaGame.id },
                    timeout: 15000
                });
                
                const players = statsResponse.data.response || [];
                
                // if no player stats found, skip game
                if (players.length === 0) {
                    notFoundCount++;
                    log(`  no player stats found`, 'WARNING');
                    continue;
                }
                
                // update defensive stats for each player
                let gameUpdates = 0;
                for (const playerData of players) {
                    const result = await updatePlayerDefensiveStats(pool, playerData, game, season);
                    if (result.updated) {
                        gameUpdates++;
                    } else if (result.unmatched) {
                        unmatchedPlayers.push(result.unmatched);
                    }
                }
                
                // log results for this game
                if (gameUpdates > 0) {
                    successCount++;
                    updatedPlayers += gameUpdates;
                    log(`  updated ${gameUpdates} players`);
                } else {
                    log(`  no players matched in database`, 'WARNING');
                }
                
                // progress update every 10 games
                if ((i + 1) % 10 === 0) {
                    log(`progress: ${i + 1}/${games.length} (${successCount} success, ${updatedPlayers} players updated, ${notFoundCount} not found, ${errorCount} errors)`);
                }
                
            } catch (error) {
                errorCount++;
                log(`  error: ${error.message}`, 'WARNING');
            }
        }
        
        // final summary
        log(`\nupdate complete`);
        log(`   games processed: ${successCount}`);
        log(`   players updated: ${updatedPlayers}`);
        log(`   not found: ${notFoundCount}`);
        log(`   errors: ${errorCount}`);
        
        // show unmatched players for debugging
        if (unmatchedPlayers.length > 0) {
            log(`\nunmatched players (first 20):`);
            const unique = [...new Set(unmatchedPlayers)].slice(0, 20);
            unique.forEach(p => log(`   - ${p}`));
        }
        
        // verify coverage statistics
        const verifyQuery = `
            SELECT 
                COUNT(*) as Total,
                SUM(CASE WHEN Steals > 0 OR Blocks > 0 OR Turnovers > 0 THEN 1 ELSE 0 END) as WithDefensiveStats
            FROM Stats
            WHERE Season = '${season}'`;
        
        const verifyResult = await pool.request().query(verifyQuery);
        const stats = verifyResult.recordset[0];
        
        log(`\n${season} defensive stats coverage:`);
        log(`   total player stats: ${stats.Total}`);
        log(`   with defensive stats: ${stats.WithDefensiveStats}`);
        log(`   coverage: ${((stats.WithDefensiveStats / stats.Total) * 100).toFixed(1)}%`);
        
    } catch (error) {
        log(`error: ${error.message}`, 'ERROR');
        console.error(error);
    } finally {
        if (pool) await pool.close();
    }
}

// update defensive stats for a single player
async function updatePlayerDefensiveStats(pool, playerData, game, season) {
    try {
        const firstName = playerData.player.firstname || '';
        const lastName = playerData.player.lastname || '';
        const fullName = `${firstName} ${lastName}`.trim();
        
        if (!lastName) {
            return { updated: false, unmatched: fullName };
        }
        
        // extract defensive stats
        const steals = playerData.steals || 0;
        const blocks = playerData.blocks || 0;
        const turnovers = playerData.turnovers || 0;
        
        // build all possible name match conditions
        const nameConditions = buildNameMatchConditions(firstName, lastName);
        
        // update stats in database
        const updateQuery = `
            UPDATE Stats
            SET 
                Steals = ${steals},
                Blocks = ${blocks},
                Turnovers = ${turnovers}
            WHERE (${nameConditions.join(' OR ')})
            AND GameId = ${game.Id}
            AND Season = '${season}'`;
        
        const result = await pool.request().query(updateQuery);
        
        if (result.rowsAffected[0] > 0) {
            return { updated: true };
        } else {
            return { updated: false, unmatched: fullName };
        }
        
    } catch (error) {
        return { updated: false, unmatched: `${playerData.player?.firstname} ${playerData.player?.lastname}` };
    }
}

// main execution
console.log('\nnba defensive stats updater\n');
console.log('usage:');
console.log('  node update-defensive-stats.js 2025-2026\n');

const args = process.argv.slice(2);

if (args.length === 0) {
    console.log('please specify a season');
    console.log('example: node update-defensive-stats.js 2025-2026');
    process.exit(1);
}

const season = args[0];
updateDefensiveStats(season).catch(console.error);