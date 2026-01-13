// ============================================
// VALUATION PRICING API
// Heavy Equipment (JCB) Valuation Engine
// ============================================

const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
require('dotenv').config();

const app = express();

// ============================================
// MIDDLEWARE
// ============================================

app.use(cors());
app.use(express.json());

// ============================================
// DATABASE CONNECTION
// ============================================

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Required for Neon
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
});

// ============================================
// PRICING DATA (2024-2025 Indian Market)
// ============================================

const PRICING_DATA = {
  'JCB 3DX': {
    basePrice: 450000, // ₹ for year 2000 (as reference point)
    yearReference: 2000,
  },
  'JCB 3CX': {
    basePrice: 400000,
    yearReference: 2000,
  },
  'JCB 4CX': {
    basePrice: 550000,
    yearReference: 2000,
  },
};

const CONDITION_MULTIPLIER = {
  excellent: 1.0,  // 100% of depreciated value
  good: 0.85,      // 85% of depreciated value
  average: 0.65,   // 65% of depreciated value
  poor: 0.45,      // 45% of depreciated value
  breakdown: 0.2,  // 20% of depreciated value (for parts)
};

// ============================================
// PRICING ALGORITHM
// ============================================

/**
 * LOGIC FLOW:
 * 1. Get base price for model
 * 2. Apply age-based depreciation (fixed % per year)
 * 3. Apply hour-based wear deduction
 * 4. Apply condition multiplier
 * 5. Apply location adjustment
 * 6. Cap depreciation at 85% max loss
 * 7. Return breakdown
 */

function calculateValuation(input) {
  // input structure:
  // {
  //   model: "JCB 3DX",
  //   year: 2018,
  //   condition: "good",
  //   location: "Haryana",
  //   hours: 4500,
  //   serialNumber: "ABC123XYZ"
  // }

  const {
    model,
    year,
    condition,
    location,
    hours,
    serialNumber,
  } = input;

  // ============================================
  // STEP 1: VALIDATE INPUT
  // ============================================

  if (!PRICING_DATA[model]) {
    return {
      error: `Model "${model}" not in pricing database`,
      status: 400,
    };
  }

  if (year < 2000 || year > 2024) {
    return {
      error: `Invalid year. Must be between 2000 and 2024`,
      status: 400,
    };
  }

  if (!CONDITION_MULTIPLIER[condition]) {
    return {
      error: `Invalid condition. Must be: excellent, good, average, poor, breakdown`,
      status: 400,
    };
  }

  // ============================================
  // STEP 2: GET BASE PRICE
  // ============================================

  const basePrice = PRICING_DATA[model].basePrice;

  // ============================================
  // STEP 3: AGE DEPRECIATION
  // ============================================

  // Formula: Every year, machine loses 10% of original value
  // After 10 years, it's worth 0% of original (in theory)
  // But we cap at 85% total loss

  const ageYears = 2024 - year;
  let ageDepreciationPercent = ageYears * 10; // 10% per year

  // Cap: Maximum 85% loss
  if (ageDepreciationPercent > 85) {
    ageDepreciationPercent = 85;
  }

  const ageDepreciationAmount = basePrice * (ageDepreciationPercent / 100);
  const priceAfterAge = basePrice - ageDepreciationAmount;

  // ============================================
  // STEP 4: HOUR-BASED WEAR DEDUCTION
  // ============================================

  // Formula: ₹50 per hour (Indian market standard for JCB)
  // This is separate from age depreciation
  // Justification: 4000 hours = normal for a year
  // 10,000 hours = heavy use

  const costPerHour = 50;
  const hourBasedDeduction = hours * costPerHour;

  // Cap: Don't let hours deduction exceed 30% of current value
  const maxHourDeduction = priceAfterAge * 0.3;
  const finalHourDeduction = Math.min(hourBasedDeduction, maxHourDeduction);

  const priceAfterHours = priceAfterAge - finalHourDeduction;

  // ============================================
  // STEP 5: CONDITION ADJUSTMENT
  // ============================================

  // Condition multiplier is applied to post-depreciation price
  // Example: "good" condition = 85% of depreciated price
  // "poor" condition = 45% of depreciated price

  const conditionMultiplier = CONDITION_MULTIPLIER[condition];
  const priceAfterCondition = priceAfterHours * conditionMultiplier;

  // ============================================
  // STEP 6: LOCATION ADJUSTMENT
  // ============================================

  // Indian market: Equipment in metro areas worth 5-10% more
  // Equipment in rural areas worth 5-10% less

  let locationAdjustmentPercent = 0;

  const metroStates = ['Delhi', 'Haryana', 'Gujarat', 'Maharashtra', 'Tamil Nadu'];
  const ruralStates = ['Bihar', 'Jharkhand', 'Uttar Pradesh', 'Madhya Pradesh'];

  if (metroStates.includes(location)) {
    locationAdjustmentPercent = 10; // +10%
  } else if (ruralStates.includes(location)) {
    locationAdjustmentPercent = -8; // -8%
  }

  const locationAdjustmentAmount = priceAfterCondition * (locationAdjustmentPercent / 100);
  const finalPrice = priceAfterCondition + locationAdjustmentAmount;

  // ============================================
  // STEP 7: CONFIDENCE SCORE
  // ============================================

  // Confidence decreases if:
  // - Hours are missing or unusually high
  // - Serial number is missing
  // - Condition is poor/breakdown

  let confidenceScore = 0.95; // Start at 95%

  if (!hours || hours === 0) {
    confidenceScore -= 0.1; // -10% if hours missing
  }

  if (hours > 12000) {
    confidenceScore -= 0.05; // -5% if unusually high
  }

  if (!serialNumber) {
    confidenceScore -= 0.05; // -5% if serial missing
  }

  if (condition === 'breakdown') {
    confidenceScore -= 0.15; // -15% if breakdown
  }

  // Floor at 0.5
  if (confidenceScore < 0.5) {
    confidenceScore = 0.5;
  }

  // ============================================
  // STEP 8: BUILD RESPONSE
  // ============================================

  return {
    success: true,
    status: 200,
    data: {
      input: {
        model,
        year,
        condition,
        location,
        hours,
        serialNumber,
      },
      breakdown: {
        basePrice: Math.round(basePrice),
        ageDepreciation: Math.round(-ageDepreciationAmount),
        hourBasedDeduction: Math.round(-finalHourDeduction),
        conditionAdjustment: Math.round(priceAfterCondition - priceAfterHours),
        locationAdjustment: Math.round(locationAdjustmentAmount),
      },
      finalPrice: Math.round(finalPrice),
      confidenceScore: Math.round(confidenceScore * 100) / 100,
      pricingNotes: [
        `Base price for ${model}: ₹${Math.round(basePrice).toLocaleString()}`,
        `Age depreciation (${ageYears} years @ 10%/year): ₹${Math.round(ageDepreciationAmount).toLocaleString()}`,
        `Hour-based wear (${hours} hours @ ₹${costPerHour}/hour): ₹${Math.round(finalHourDeduction).toLocaleString()}`,
        `Condition adjustment (${condition}): ${Math.round(conditionMultiplier * 100)}% of depreciated value`,
        `Location adjustment (${location}): ${locationAdjustmentPercent > 0 ? '+' : ''}${locationAdjustmentPercent}%`,
        `Confidence score: ${Math.round(confidenceScore * 100)}%`,
      ],
    },
  };
}

// ============================================
// API ROUTES
// ============================================

/**
 * POST /estimate
 * Calculate valuation for equipment
 */
app.post('/estimate', async (req, res) => {
  try {
    const { model, year, condition, location, hours, serialNumber } = req.body;

    // Validate required fields
    if (!model || !year || !condition || !location) {
      return res.status(400).json({
        error: 'Missing required fields: model, year, condition, location',
      });
    }

    // Calculate valuation
    const result = calculateValuation({
      model,
      year,
      condition,
      location,
      hours: hours || 0,
      serialNumber: serialNumber || '',
    });

    if (result.error) {
      return res.status(result.status || 400).json({ error: result.error });
    }

    // ============================================
    // SAVE TO DATABASE
    // ============================================

    const {
      input,
      breakdown,
      finalPrice,
      confidenceScore,
      pricingNotes,
    } = result.data;

    try {
      const query = `
        INSERT INTO valuations (
          model,
          year,
          condition,
          location,
          hours_reading,
          serial_number,
          base_price,
          age_depreciation,
          hour_based_deduction,
          condition_adjustment,
          location_adjustment,
          final_price,
          confidence_score,
          pricing_api_response
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        RETURNING id;
      `;

      const values = [
        input.model,
        input.year,
        input.condition,
        input.location,
        input.hours,
        input.serialNumber,
        breakdown.basePrice,
        breakdown.ageDepreciation,
        breakdown.hourBasedDeduction,
        breakdown.conditionAdjustment,
        breakdown.locationAdjustment,
        finalPrice,
        confidenceScore,
        JSON.stringify(result),
      ];

      const dbResult = await pool.query(query, values);
      const valuationId = dbResult.rows[0].id;

      // Return with valuation ID
      result.data.valuationId = valuationId;
    } catch (dbError) {
      console.error('Database error:', dbError);
      // Still return pricing result even if DB fails
    }

    res.json(result);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /health
 * Health check for Render monitoring
 */
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/**
 * GET /models
 * List available models
 */
app.get('/models', (req, res) => {
  res.json({
    models: Object.keys(PRICING_DATA),
    conditions: Object.keys(CONDITION_MULTIPLIER),
    supportedLocations: [
      'Delhi', 'Haryana', 'Gujarat', 'Maharashtra', 'Tamil Nadu',
      'Bihar', 'Jharkhand', 'Uttar Pradesh', 'Madhya Pradesh',
    ],
  });
});

// ============================================
// ERROR HANDLING
// ============================================

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

// ============================================
// START SERVER
// ============================================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Valuation API running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV}`);
});
