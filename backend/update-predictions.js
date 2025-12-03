// update-predictions.js 
// imports mssql library to connect to azure sql database
const sql = require('mssql');

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

// main function to update predictions with actual game results
async function updatePredictions() {
    let pool; // database connection variable
    
    try {
        // connect to azure sql database
        pool = await sql.connect(dbConfig);
        console.log('Connected to database\n');
        
        // check how many predictions are still waiting for actual results
        const checkQuery = `
            SELECT COUNT(*) as PendingPredictions
            FROM MLPredictions
            WHERE GameCompleted = 0
        `;
        
        // execute the query and get the count
        const checkResult = await pool.request().query(checkQuery);
        const pending = checkResult.recordset[0].PendingPredictions;
        
        console.log(`Found ${pending} predictions waiting for actual results...\n`);
        
        // if no predictions need updating, exit early
        if (pending === 0) {
            console.log('All predictions already updated!');
            return;
        }
        
        console.log('Updating predictions with actual game results...');
        
        // update predictions by matching them with actual stats from completed games
        const updateQuery = `
    UPDATE mp
    SET 
        mp.ActualPoints = s.Points, // fill in actual points from stats table
        mp.ActualRebounds = s.TotalRebounds, // fill in actual rebounds
        mp.ActualAssists = s.Assists, // fill in actual assists
        mp.PointsError = ABS(mp.PredictedPoints - s.Points), // calculate how far off we were for points
        mp.ReboundsError = ABS(mp.PredictedRebounds - s.TotalRebounds), // calculate rebounds error
        mp.AssistsError = ABS(mp.PredictedAssists - s.Assists), // calculate assists error
        mp.GameCompleted = 1 // mark this prediction as completed
    FROM MLPredictions mp
    JOIN Stats s ON (
        s.PlayerName = SUBSTRING(mp.PlayerName, CHARINDEX(' ', mp.PlayerName) + 1, 100) + ' ' + 
                       SUBSTRING(mp.PlayerName, 1, CHARINDEX(' ', mp.PlayerName) - 1)
    ) // match player names - converting "first last" to "last first" format
    JOIN Games g ON s.GameId = g.Id // join to games table to check game status
    WHERE mp.GameCompleted = 0 // only update predictions that haven't been completed yet
        AND g.Status IN ('FT', 'AOT') // only games that are finished or after overtime
        AND s.Season = '2025-2026' // only current season stats
        AND (
            g.HomeTeam LIKE '%' + mp.OpponentTeam + '%'
            OR g.AwayTeam LIKE '%' + mp.OpponentTeam + '%'
        ) // match the opponent team from prediction to actual game
`;
        
        // execute the update and get how many rows were affected
        const updateResult = await pool.request().query(updateQuery);
        const updated = updateResult.rowsAffected[0];
        
        console.log(`Updated ${updated} predictions with actual results\n`);
        
        console.log('ACCURACY SUMMARY\n');
        
        // calculate accuracy statistics across all completed predictions
        const accuracyQuery = `
            SELECT 
                COUNT(*) as TotalCompleted, // total number of completed predictions
                AVG(PointsError) as AvgPointsError, // average error for points
                AVG(ReboundsError) as AvgReboundsError, // average error for rebounds
                AVG(AssistsError) as AvgAssistsError, // average error for assists
                SUM(CASE WHEN PointsError <= 5 THEN 1 ELSE 0 END) * 100.0 / COUNT(*) as PointsWithin5Pct, // percentage of predictions within 5 points
                MIN(PointsError) as BestPointsPrediction, // closest prediction
                MAX(PointsError) as WorstPointsPrediction // worst prediction
            FROM MLPredictions
            WHERE GameCompleted = 1 // only look at completed predictions
        `;
        
        // execute accuracy query
        const accuracyResult = await pool.request().query(accuracyQuery);
        const stats = accuracyResult.recordset[0];
        
        // if there are completed predictions, display the accuracy stats
        if (stats.TotalCompleted > 0) {
            console.log(`Total Predictions: ${stats.TotalCompleted}`);
            console.log(`\nAverage Errors:`);
            console.log(`  Points:   ${stats.AvgPointsError.toFixed(2)} pts`); // .toFixed(2) rounds to 2 decimal places
            console.log(`  Rebounds: ${stats.AvgReboundsError.toFixed(2)} reb`);
            console.log(`  Assists:  ${stats.AvgAssistsError.toFixed(2)} ast`);
            console.log(`\nAccuracy:`);
            console.log(`  ${stats.PointsWithin5Pct.toFixed(1)}% of point predictions within 5 pts`);
            console.log(`  Best prediction: ${stats.BestPointsPrediction.toFixed(1)} pts off`);
            console.log(`  Worst prediction: ${stats.WorstPointsPrediction.toFixed(1)} pts off`);
        }
        
        console.log('\nRECENT PREDICTIONS\n');
        
        // get the 10 most recent predictions to show as examples
        const examplesQuery = `
            SELECT TOP 10
                PlayerName,
                OpponentTeam,
                GameDate,
                PredictedPoints,
                ActualPoints,
                PointsError,
                CASE // assign an accuracy rating based on how far off the prediction was
                    WHEN PointsError <= 3 THEN 'Excellent'
                    WHEN PointsError <= 5 THEN 'Good'
                    WHEN PointsError <= 8 THEN 'Fair'
                    ELSE 'Miss'
                END as Accuracy
            FROM MLPredictions
            WHERE GameCompleted = 1
            ORDER BY GameDate DESC // most recent games first
        `;
        
        // execute the examples query
        const examples = await pool.request().query(examplesQuery);
        
        // loop through each example prediction and display it
        examples.recordset.forEach(pred => {
            const date = new Date(pred.GameDate).toLocaleDateString(); // format date nicely
            console.log(`${pred.Accuracy} ${pred.PlayerName} vs ${pred.OpponentTeam} (${date})`);
            console.log(`   Predicted: ${pred.PredictedPoints} pts | Actual: ${pred.ActualPoints} pts | Error: ${pred.PointsError.toFixed(1)} pts\n`);
        });
        
        console.log('\nUpdate complete!');
        
    } catch (error) {
        // if anything goes wrong, print the error
        console.error('Error:', error.message);
        console.error(error);
    } finally {
        // always close the database connection, even if there was an error
        if (pool) {
            await pool.close();
        }
    }
}

// run the update function when script is executed
console.log('\nNBA Prediction Accuracy Tracker\n');
updatePredictions().catch(console.error); // if update function fails, print the error