import { Webhook } from "svix";
import User from "../models/User.js";
import stripe from "stripe";
import { Purchase } from "../models/Purchase.js";
import Course from "../models/Course.js";



// API Controller Function to Manage Clerk User with database
export const clerkWebhooks = async (req, res) => {
  try {

    // Create a Svix instance with clerk webhook secret.
    const whook = new Webhook(process.env.CLERK_WEBHOOK_SECRET)

    // Verifying Headers
    await whook.verify(JSON.stringify(req.body), {
      "svix-id": req.headers["svix-id"],
      "svix-timestamp": req.headers["svix-timestamp"],
      "svix-signature": req.headers["svix-signature"]
    })

    // Getting Data from request body
    const { data, type } = req.body

    // Switch Cases for differernt Events
    switch (type) {
      case 'user.created': {

        const userData = {
          _id: data.id,
          email: data.email_addresses[0].email_address,
          name: data.first_name + " " + data.last_name,
          imageUrl: data.image_url,
          resume: ''
        }
        await User.create(userData)
        res.json({})
        break;
      }

      case 'user.updated': {
        const userData = {
          email: data.email_addresses[0].email_address,
          name: data.first_name + " " + data.last_name,
          imageUrl: data.image_url,
        }
        await User.findByIdAndUpdate(data.id, userData)
        res.json({})
        break;
      }

      case 'user.deleted': {
        await User.findByIdAndDelete(data.id)
        res.json({})
        break;
      }
      default:
        break;
    }

  } catch (error) {
    res.json({ success: false, message: error.message })
  }
}


// Stripe Gateway Initialize
const stripeInstance = new stripe(process.env.STRIPE_SECRET_KEY)


// Stripe Webhooks to Manage Payments Action
export const stripeWebhooks = async (request, response) => {
  const sig = request.headers['stripe-signature'];

  let event;

  try {
    // Get raw body for signature verification
    let body = request.body;
    
    // If body is already parsed (common in Vercel), we need to reconstruct it
    if (typeof body === 'object' && body !== null) {
      body = JSON.stringify(body);
    }

    // Verify webhook signature
    event = stripeInstance.webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    console.log('✅ Webhook signature verified successfully');
  }
  catch (err) {
    console.error('❌ Webhook signature verification failed:', err.message);
    console.error('Request body type:', typeof request.body);
    console.error('Request headers:', request.headers);
    return response.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log(`📨 Received webhook event: ${event.type}`);

  // Handle the event
  try {
    switch (event.type) {
      case 'payment_intent.succeeded': {
        console.log('💰 Processing successful payment...');
        
        const paymentIntent = event.data.object;
        const paymentIntentId = paymentIntent.id;
        console.log('Payment Intent ID:', paymentIntentId);

        // Getting Session Metadata
        const session = await stripeInstance.checkout.sessions.list({
          payment_intent: paymentIntentId,
        });

        if (!session.data || session.data.length === 0) {
          console.error('❌ No session found for payment intent:', paymentIntentId);
          return response.status(400).json({ error: 'No session found' });
        }

        const { purchaseId } = session.data[0].metadata;
        console.log('Purchase ID from metadata:', purchaseId);

        if (!purchaseId) {
          console.error('❌ No purchaseId found in session metadata');
          return response.status(400).json({ error: 'No purchaseId in metadata' });
        }

        const purchaseData = await Purchase.findById(purchaseId);
        if (!purchaseData) {
          console.error('❌ Purchase not found:', purchaseId);
          return response.status(400).json({ error: 'Purchase not found' });
        }

        const userData = await User.findById(purchaseData.userId);
        if (!userData) {
          console.error('❌ User not found:', purchaseData.userId);
          return response.status(400).json({ error: 'User not found' });
        }

        const courseData = await Course.findById(purchaseData.courseId.toString());
        if (!courseData) {
          console.error('❌ Course not found:', purchaseData.courseId);
          return response.status(400).json({ error: 'Course not found' });
        }

        // Check if user is already enrolled
        if (userData.enrolledCourses.includes(courseData._id)) {
          console.log('⚠️ User already enrolled in course');
        } else {
          // Add user to course enrolled students
          courseData.enrolledStudents.push(userData);
          await courseData.save();
          console.log('✅ User added to course enrolled students');

          // Add course to user's enrolled courses
          userData.enrolledCourses.push(courseData._id);
          await userData.save();
          console.log('✅ Course added to user enrolled courses');
        }

        // Update purchase status
        purchaseData.status = 'completed';
        await purchaseData.save();
        console.log('✅ Purchase status updated to completed');

        break;
      }
      case 'payment_intent.payment_failed': {
        console.log('❌ Processing failed payment...');
        
        const paymentIntent = event.data.object;
        const paymentIntentId = paymentIntent.id;

        // Getting Session Metadata
        const session = await stripeInstance.checkout.sessions.list({
          payment_intent: paymentIntentId,
        });

        if (session.data && session.data.length > 0) {
          const { purchaseId } = session.data[0].metadata;
          
          if (purchaseId) {
            const purchaseData = await Purchase.findById(purchaseId);
            if (purchaseData) {
              purchaseData.status = 'failed';
              await purchaseData.save();
              console.log('✅ Purchase status updated to failed');
            }
          }
        }

        break;
      }
      default:
        console.log(`⚠️ Unhandled event type: ${event.type}`);
    }

    // Return a response to acknowledge receipt of the event
    response.json({ received: true });
    
  } catch (error) {
    console.error('❌ Error processing webhook:', error);
    response.status(500).json({ error: 'Internal server error' });
  }
}