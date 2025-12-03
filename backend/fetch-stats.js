const sql = require('mssql'); //imports mssql library
const axios = require('axios'); //library for making http requests

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

//api keys, and api base url

const API_KEY = 'YOUR_API_KEY';
const BASE_URL = 'https://v1.basketball.api-sports.io';

//just a helper function for a simple logging function 
function log(message, level = 'INFO') {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${level}: ${message}`);
}

//fetch current season data
async function fetchCurrentSeasonData() {

    //connect to azure sql database
    let pool;
    
    try {
        pool = await sql.connect(dbConfig);
        log('✓ Connected to database');
        
        // step 1: check api status
        //calls to the api to check how many requests i have left

        log('\nChecking API Status');
        
        //makes an http get request to check api status
        const statusResponse = await axios.get(`${BASE_URL}/status`, {
            headers: {
                'x-rapidapi-key': API_KEY,
                'x-rapidapi-host': 'v1.basketball.api-sports.io'
            }
        });
        
        log(`API requests remaining today: ${statusResponse.data.response.requests.limit_day - statusResponse.data.response.requests.current_day}`);
        
        // step 2: check for 2025-2026 data
        //asks the api how many 2025-2026 nba games it has

        log('\nChecking for 2025-2026 Season Games');
        
        //makes an api request 
        const current2526Response = await axios.get(`${BASE_URL}/games`, {
            headers: {
                'x-rapidapi-key': API_KEY,
                'x-rapidapi-host': 'v1.basketball.api-sports.io'
            },
            params: {
                league: '12',  // the nba
                season: '2025-2026'
            }
        });
        
        //extracts game data from the response, if it is undefined or null = return empty array instead
        const games2526 = current2526Response.data.response || [];
        log(`Found ${games2526.length} games for 2025-2026 season in API`);
        
        //checks if any games were found, and if so, give information
        if (games2526.length > 0) {
            log(`First game: ${games2526[0].date}`);
            log(`Latest game: ${games2526[games2526.length - 1].date}`);
            
            // check how many are finished
            const finishedGames = games2526.filter(g => g.status.short === 'FT');
            log(`${finishedGames.length} finished games with stats available`);
        }
        
        // step 3: get games from our database that need stats
        log('\nGames in Database Needing Stats');
        
        //sql query that counts games in the database
        const dbGamesQuery = `
            SELECT 
                COUNT(*) as Total,
                SUM(CASE WHEN YEAR(StartTime) = 2025 AND MONTH(StartTime) >= 10 THEN 1 ELSE 0 END) as Season2526,
                SUM(CASE WHEN YEAR(StartTime) = 2025 AND MONTH(StartTime) < 10 THEN 1 ELSE 0 END) as Season2425,
                SUM(CASE WHEN YEAR(StartTime) = 2024 THEN 1 ELSE 0 END) as Season2324
            FROM Games g
            WHERE g.Status IN ('FT', 'AOT')
            AND StartTime < GETDATE()
            AND NOT EXISTS (SELECT 1 FROM Stats s WHERE s.GameId = g.Id)
        `;
        
        //executes the sql query
        const dbGames = await pool.request().query(dbGamesQuery);
        const counts = dbGames.recordset[0];
        
        log(`Games without stats in database:`);
        log(`  2025-26 season (Oct 2025+): ${counts.Season2526} games`);
        log(`  2024-25 season (2025 before Oct): ${counts.Season2425} games`);
        log(`  2023-24 season (2024): ${counts.Season2324} games`);
        
    } catch (error) {
        log(`Error: ${error.message}`, 'ERROR');
        console.error(error);
    } finally {
        if (pool) {
            await pool.close();
        }
    }
}



// function to fetch stats for a specific season
async function updateSeasonAndFetch(season) {
    let pool;
    
    try {
        pool = await sql.connect(dbConfig);
        log(`\nFetching Stats for ${season}`);

        //mark past games as finished
        //past games should be marked as FT = finished 

        log('Marking past scheduled games as finished...');

        const pastGamesUpdate = await pool.request().query(`
            UPDATE Games
            SET Status = 'FT'
            WHERE StartTime < GETDATE()
            AND Status NOT IN ('FT', 'AOT', 'CANC', 'POST')
        `);

        log(`✓ Marked ${pastGamesUpdate.rowsAffected[0]} past games as finished`);

        log('Updating game statuses from API (last 30 days)');
        
        //update game status from api

        log('Updating game statuses from API (last 30 days)');
        
        // only check last 30 days
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        const fromDate = thirtyDaysAgo.toISOString().split('T')[0];
        
        //fetch recent game status from api (last 30 days)
        try {
            const statusResponse = await axios.get(`${BASE_URL}/games`, {
                headers: {
                    'x-rapidapi-key': API_KEY,
                    'x-rapidapi-host': 'v1.basketball.api-sports.io'
                },
                params: {
                    league: '12',
                    season: season,
                    from: fromDate
                }
            });
            
            const apiGames = statusResponse.data.response || [];
            let statusUpdates = 0;
            
            //loop through and update each game
            //if home and away socres are undefined or null use 0

            for (const game of apiGames) {
                try {
                    await pool.request().query(`
                        UPDATE Games 
                        SET Status = '${game.status.short}',
                            ScoreHome = ${game.scores.home.total || 0},
                            ScoreAway = ${game.scores.away.total || 0}
                        WHERE APISportsId = ${game.id}
                    `);
                    statusUpdates++;
                } catch (err) {
                    // Continue on error
                }
            }
            
            log(`✓ Updated ${statusUpdates} game statuses`);
        } catch (error) {
            log(`Warning: Could not update game statuses: ${error.message}`, 'WARNING');
        }
        
        //fetch the games that needs stats
        //this builds a sql condition based on which season we are fetching
        let yearCondition;
        if (season === '2025-2026') {
            yearCondition = `YEAR(StartTime) = 2025 AND MONTH(StartTime) >= 10 OR YEAR(StartTime) = 2026`;
        } else if (season === '2024-2025') {
            yearCondition = `YEAR(StartTime) = 2024 AND MONTH(StartTime) >= 10 OR (YEAR(StartTime) = 2025 AND MONTH(StartTime) < 10)`;
        } else if (season === '2023-2024') {
            yearCondition = `YEAR(StartTime) = 2023 AND MONTH(StartTime) >= 10 OR (YEAR(StartTime) = 2024 AND MONTH(StartTime) < 10)`;
        } else {
            yearCondition = `YEAR(StartTime) = 2022 AND MONTH(StartTime) >= 10 OR (YEAR(StartTime) = 2023 AND MONTH(StartTime) < 10)`;
        }
        
        //query to get the games needing stats
        //up to 500 games

        const gamesQuery = `
            SELECT TOP 500
                g.Id, 
                g.APISportsId, 
                g.StartTime, 
                g.HomeTeam, 
                g.AwayTeam
            FROM Games g
            WHERE g.Status IN ('FT', 'AOT')
            AND (${yearCondition})
            AND NOT EXISTS (SELECT 1 FROM Stats s WHERE s.GameId = g.Id AND s.Season = '${season}')
            ORDER BY g.StartTime DESC
        `;
        
        //execute query and check the results
        const gamesResult = await pool.request().query(gamesQuery);
        const games = gamesResult.recordset;
        
        log(`Found ${games.length} games to fetch`);
        
        if (games.length === 0) {
            log('✓ All games already have stats!');
            return;
        }
        
        log(`Starting fetch... (this will take ~${Math.ceil(games.length * 2 / 60)} minutes)`);
        
        //initalize the counters
        let successCount = 0;
        let emptyCount = 0;
        let errorCount = 0;
        let playerInsertCount = 0;
        
        //looping through each game
        for (let i = 0; i < games.length; i++) {
            const game = games[i];
            
            try {
                // rate limiting - 2 seconds between calls
                if (i > 0) await new Promise(resolve => setTimeout(resolve, 2000));
                
                const response = await axios.get(`${BASE_URL}/games/statistics/players`, {
                    headers: {
                        'x-rapidapi-key': API_KEY,
                        'x-rapidapi-host': 'v1.basketball.api-sports.io'
                    },
                    params: {
                        id: game.APISportsId
                    },
                    timeout: 15000
                });
                
                const players = response.data.response || [];
                
                //handle empty response
                if (players.length === 0) {
                    emptyCount++;
                    if ((i + 1) % 10 === 0) {
                        log(`Progress: ${i + 1}/${games.length} (${successCount} success, ${playerInsertCount} players, ${emptyCount} empty, ${errorCount} errors)`);
                    }
                    continue;
                }
                
                // process each player
                let gamePlayerCount = 0;
                for (const playerData of players) {
                    const inserted = await insertPlayerStats(pool, playerData, game, season);
                    if (inserted) gamePlayerCount++;
                }
                
                if (gamePlayerCount > 0) {
                    successCount++;
                    playerInsertCount += gamePlayerCount;
                }
                
                if ((i + 1) % 10 === 0) {
                    log(`Progress: ${i + 1}/${games.length} (${successCount} success, ${playerInsertCount} players, ${emptyCount} empty, ${errorCount} errors)`);
                }
                
            } catch (error) {
                errorCount++;
                log(`Error on game ${game.APISportsId}: ${error.message}`, 'WARNING');
            }
        }

        //final summary
        
        log(`\nFetch Complete!`);
        log(`   Games processed: ${successCount}`);
        log(`   Players inserted: ${playerInsertCount}`);
        log(`   Empty: ${emptyCount}`);
        log(`   Errors: ${errorCount}`);
        
        // check results
        const statsCount = await pool.request().query(`
            SELECT COUNT(*) as count FROM Stats WHERE Season = '${season}'
        `);
        
        const playersCount = await pool.request().query(`
            SELECT COUNT(DISTINCT PlayerApiId) as count FROM Stats WHERE Season = '${season}'
        `);
        
        //log the totals
        log(`\n${season} Season Data:`);
        log(`   Player Stats Records: ${statsCount.recordset[0].count}`);
        log(`   Unique Players: ${playersCount.recordset[0].count}`);
        
        if (statsCount.recordset[0].count > 0) {
            log('\nSuccess! Next steps:');
            log('   1. Run configure.js to populate PlayerAggregates');
            log('   2. Train ML model: python3 train_model.py');
        }

        //fetch defensive stats using the nba api

        log('\nFetching Defensive Stats');
        
        const NBA_API_KEY = '9f957349706083c644571814dadcbfef';
        const NBA_BASE_URL = 'https://v2.nba.api-sports.io';
        
        try {
            // get games that need defensive stats
            const defensiveGamesQuery = `
                SELECT 
                    g.Id, 
                    g.APISportsId,
                    g.HomeTeam,
                    g.AwayTeam,
                    g.StartTime
                FROM Games g
                WHERE g.Status IN ('FT', 'AOT')
                AND (YEAR(g.StartTime) = 2025 AND MONTH(g.StartTime) >= 10 OR YEAR(g.StartTime) = 2026)
                AND EXISTS (
                    SELECT 1 FROM Stats 
                    WHERE GameId = g.Id 
                    AND Season = '${season}'
                )
                AND NOT EXISTS (
                    SELECT 1 FROM Stats 
                    WHERE GameId = g.Id 
                    AND Season = '${season}'
                    AND Steals > 0
                )
                ORDER BY g.StartTime DESC`;
            
            //execute the query and check results
            const defensiveGamesResult = await pool.request().query(defensiveGamesQuery);
            const defensiveGames = defensiveGamesResult.recordset;
            
            log(`Found ${defensiveGames.length} games needing defensive stats`);
            
            if (defensiveGames.length === 0) {
                log('All games already have defensive stats!');
            } else {
                //initalize counters
                let defensiveSuccessCount = 0;
                let defensiveErrorCount = 0;
                let defensiveUpdatedPlayers = 0;
                
                //loop through all games or 100 , whichever is smaller
                for (let i = 0; i < Math.min(defensiveGames.length, 100); i++) {
                    const game = defensiveGames[i];
                    
                    try {
                        // rate limit: 2 seconds
                        if (i > 0) await new Promise(resolve => setTimeout(resolve, 2000));
                        
                        // search for game in NBA API
                        const gameDate = new Date(game.StartTime).toISOString().split('T')[0];
                        
                        const gamesResponse = await axios.get(`${NBA_BASE_URL}/games`, {
                            headers: {
                                'x-rapidapi-key': NBA_API_KEY,
                                'x-rapidapi-host': 'v2.nba.api-sports.io'
                            },
                            params: { date: gameDate },
                            timeout: 15000
                        });
                        
                        const nbaGames = gamesResponse.data.response || [];
                        
                        // find matching game
                        const normalizeTeam = (name) => name.toLowerCase().replace('la ', 'los angeles ').trim();
                        const nbaGame = nbaGames.find(g => {
                            const homeMatch = normalizeTeam(g.teams.home.name) === normalizeTeam(game.HomeTeam);
                            const awayMatch = normalizeTeam(g.teams.visitors.name) === normalizeTeam(game.AwayTeam);
                            return homeMatch && awayMatch;
                        });
                        
                        //no match
                        if (!nbaGame) {
                            defensiveErrorCount++;
                            continue;
                        }
                        
                        // get player stats from NBA API
                        await new Promise(resolve => setTimeout(resolve, 1000));
                        
                        const statsResponse = await axios.get(`${NBA_BASE_URL}/players/statistics`, {
                            headers: {
                                'x-rapidapi-key': NBA_API_KEY,
                                'x-rapidapi-host': 'v2.nba.api-sports.io'
                            },
                            params: { game: nbaGame.id },
                            timeout: 15000
                        });
                        
                        const players = statsResponse.data.response || [];
                        
                        //empty responses
                        if (players.length === 0) {
                            defensiveErrorCount++;
                            continue;
                        }
                        
                        // update defensive stats for each player (loop through each player and extract defensive stats)
                        let gameUpdates = 0;
                        for (const playerData of players) {
                            const firstName = playerData.player.firstname || '';
                            const lastName = playerData.player.lastname || '';
                            
                            if (!lastName) continue;
                            
                            const steals = playerData.steals || 0;
                            const blocks = playerData.blocks || 0;
                            const turnovers = playerData.turnovers || 0;
                            
                            // try to match by name 
                            const fullName = `${firstName} ${lastName}`.replace(/'/g, "''");
                            
                            const updateResult = await pool.request().query(`
                                UPDATE Stats
                                SET Steals = ${steals},
                                    Blocks = ${blocks},
                                    Turnovers = ${turnovers}
                                WHERE (PlayerName LIKE '%${firstName}%${lastName}%' 
                                   OR PlayerName LIKE '%${lastName}%${firstName}%')
                                AND GameId = ${game.Id}
                                AND Season = '${season}'
                            `);
                            
                            if (updateResult.rowsAffected[0] > 0) {
                                gameUpdates++;
                            }
                        }
                        
                        if (gameUpdates > 0) {
                            defensiveSuccessCount++;
                            defensiveUpdatedPlayers += gameUpdates;
                        }
                        
                        if ((i + 1) % 10 === 0) {
                            log(`Defensive stats progress: ${i + 1}/${Math.min(defensiveGames.length, 100)} (${defensiveSuccessCount} games, ${defensiveUpdatedPlayers} players)`);
                        }
                        
                    } catch (error) {
                        defensiveErrorCount++;
                    }
                }
                
                log(`\nDefensive Stats Update Complete!`);
                log(`   Games processed: ${defensiveSuccessCount}`);
                log(`   Players updated: ${defensiveUpdatedPlayers}`);
                log(`   Errors: ${defensiveErrorCount}`);
            }
            
            // check coverage
            const coverageResult = await pool.request().query(`
                SELECT 
                    COUNT(*) as Total,
                    SUM(CASE WHEN Steals > 0 THEN 1 ELSE 0 END) as WithSteals,
                    SUM(CASE WHEN Blocks > 0 THEN 1 ELSE 0 END) as WithBlocks,
                    SUM(CASE WHEN Turnovers > 0 THEN 1 ELSE 0 END) as WithTurnovers
                FROM Stats
                WHERE Season = '${season}'
            `);
            
            const coverage = coverageResult.recordset[0];
            const stealsPercent = Math.round((coverage.WithSteals / coverage.Total) * 100);
            const blocksPercent = Math.round((coverage.WithBlocks / coverage.Total) * 100);
            const turnoversPercent = Math.round((coverage.WithTurnovers / coverage.Total) * 100);
            
            //log percentages
            log(`\nDefensive Stats Coverage for ${season}:`);
            log(`   Steals: ${stealsPercent}% (${coverage.WithSteals}/${coverage.Total})`);
            log(`   Blocks: ${blocksPercent}% (${coverage.WithBlocks}/${coverage.Total})`);
            log(`   Turnovers: ${turnoversPercent}% (${coverage.WithTurnovers}/${coverage.Total})`);
            
        } catch (error) {
            log(`Warning: Could not fetch defensive stats: ${error.message}`, 'WARNING');
        }
        
    } catch (error) {
        log(`Error: ${error.message}`, 'ERROR');
        console.error(error);
    } finally {
        if (pool) {
            await pool.close();
        }
    }
}

//this function handles inserting one players stats
async function insertPlayerStats(pool, playerData, game, season) {
    try {
        const player = playerData.player || {};
        const apiTeamId = playerData.team?.id;
        
        if (!player.id || !apiTeamId) {
            return false;
        }
        
        // look up team by APISportsId
        const teamResult = await pool.request().query(`
            SELECT Id, TeamName FROM Teams WHERE APISportsId = ${apiTeamId}
        `);
        
        if (teamResult.recordset.length === 0) {
            return false;
        }
        
        const teamId = teamResult.recordset[0].Id;
        const teamName = teamResult.recordset[0].TeamName;
        
        // extract stats
        const points = playerData.points || 0;
        const assists = playerData.assists || 0;
        const minutes = playerData.minutes || '0:00';
        
        const fgMade = playerData.field_goals?.total || 0;
        const fgAttempts = playerData.field_goals?.attempts || 0;
        const fgPct = playerData.field_goals?.percentage || 0;
        
        const tpMade = playerData.threepoint_goals?.total || 0;
        const tpAttempts = playerData.threepoint_goals?.attempts || 0;
        const tpPct = playerData.threepoint_goals?.percentage || 0;
        
        const ftMade = playerData.freethrows_goals?.total || 0;
        const ftAttempts = playerData.freethrows_goals?.attempts || 0;
        const ftPct = playerData.freethrows_goals?.percentage || 0;
        
        const totalRebounds = playerData.rebounds?.total || 0;
        const offRebounds = playerData.rebounds?.offensive || 0;
        const defRebounds = playerData.rebounds?.defensive || 0;
        
        const steals = playerData.steals || 0;
        const blocks = playerData.blocks || 0;
        const turnovers = playerData.turnovers || 0;
        const fouls = playerData.fouls?.personal || 0;
        const plusMinus = playerData.plusminus || 0;
        
        const escapedPlayerName = player.name.replace(/'/g, "''");
        const escapedTeamName = teamName.replace(/'/g, "''");
        
        const insertQuery = `
            INSERT INTO Stats (
                PlayerApiId, PlayerName, GameId, GameDate, Season, TeamId, TeamName,
                MinutesPlayed, Points, 
                FieldGoalsMade, FieldGoalsAttempted, FieldGoalPercentage,
                ThreePointersMade, ThreePointersAttempted, ThreePointPercentage,
                FreeThrowsMade, FreeThrowsAttempted, FreeThrowPercentage,
                OffensiveRebounds, DefensiveRebounds, TotalRebounds,
                Assists, Steals, Blocks, Turnovers, PersonalFouls, PlusMinus
            ) VALUES (
                ${player.id}, 
                '${escapedPlayerName}', 
                ${game.Id}, 
                '${game.StartTime.toISOString().split('T')[0]}',
                '${season}',
                ${teamId},
                '${escapedTeamName}',
                '${minutes}',
                ${points},
                ${fgMade},
                ${fgAttempts},
                ${fgPct || 0},
                ${tpMade},
                ${tpAttempts},
                ${tpPct || 0},
                ${ftMade},
                ${ftAttempts},
                ${ftPct || 0},
                ${offRebounds},
                ${defRebounds},
                ${totalRebounds},
                ${assists},
                ${steals},
                ${blocks},
                ${turnovers},
                ${fouls},
                ${plusMinus}
            )`;
        
        await pool.request().query(insertQuery);
        return true;
        
    } catch (error) {
        // silently continue on individual player errors
        return false;
    }
}

// main execution
console.log('\nNBA Data Fetcher - 2025-2026 Season\n');
console.log('Usage:');
console.log('  node fetch-current-season-data.js          - Check what data is available');
console.log('  node fetch-current-season-data.js fetch     - Fetch latest season (2025-2026)');
console.log('  node fetch-current-season-data.js fetch 2025-2026  - Fetch specific season\n');

const args = process.argv.slice(2);

if (args[0] === 'fetch' && args[1]) {
    // fetch specific season
    updateSeasonAndFetch(args[1]).catch(console.error);
} else if (args[0] === 'fetch') {
    // fetch latest (2025-2026)
    updateSeasonAndFetch('2025-2026').catch(console.error);
} else {
    // just check what's available
    fetchCurrentSeasonData().catch(console.error);
}