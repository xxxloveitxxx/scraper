#!/usr/bin/env python3
"""
ICP Filter Script for ReplyzeAI
Filters scraped leads based on emergency services criteria.

EXCLUDE rules:
- review_count < 20 (not enough volume)
- review_count > 800 (too big, has call center)
- email is missing
- email = generic placeholder (info@mysite.com, john@doe.com, etc.)
- category/about contains: cleaning, washing, painting, care, home care, companion, maid, janitorial
- hours ≠ Open 24 hours (not emergency-focused)
- FRANCHISE brands: SERVPRO, Mr. Appliance, Franchise
- WRONG NICHE: insurance companies, resellers, non-service businesses

SCORING:
- ⭐⭐⭐ Personal emails (gmail, hotmail, aol, outlook) + tech_stack = Top Priority
- ⭐⭐ Personal emails (gmail, hotmail, aol, outlook) = High Priority 
- ⭐ Named business emails (owner name detected) = Medium Priority
- ⭐ Generic business emails = Normal Priority
"""

import csv
import re
from datetime import datetime

# EXCLUDE keywords - any match = auto-reject
EXCLUDE_KEYWORDS = [
    'cleaning', 'cleaning service', 'house cleaning', 'maid service',
    'pressure washing', 'window cleaning', 'landscaping', 'landscape',
    'painting', 'home care', 'home health', 'companion care',
    'companion', 'janitorial', 'maid', 'housekeeping',
    'clean ', 'cleaning',  # Match "clean" as standalone word
]

# Emergency service keywords for detection
EMERGENCY_KEYWORDS = [
    'emergency', 'urgent', '24 hour', '24/7', 'repair', 'plumber',
    'hvac', 'heating', 'cooling', 'ac repair', 'air conditioning',
    'garage door', 'water damage', 'flood', 'restoration', 'appliance',
    'electrical', 'locksmith', 'roof', 'leak'
]

# PLACEHOLDER emails - auto-reject (not real business emails)
PLACEHOLDER_EMAIL_PATTERNS = [
    'info@mysite.com',  # Explicit placeholder
    'john@doe.com',    # Fake test email
    'test@',           # Test emails
    'example@',        # Example emails
]

# FRANCHISE brands to reject (too big for SMB tool)
FRANCHISE_KEYWORDS = [
    'servpro', 'servpro of', 'mr. appliance', 'mrappliance',
    'franchise', 'franchised', 'corporate', 'enterprise',
    'moldex', 'servicemaster', 'puroclean',
]

# WRONG NICHE - not emergency service businesses
WRONG_NICHE_KEYWORDS = [
    'insurance', 'flood insurance', 'coverage', 'policy',
    'reseller', 'retail', 'store', 'sell ', ' sells ',
    'home goods', 'furniture', 'appliance store',
]

# Generic email prefixes that should be treated as suspicious (but not automatic rejection)
SUSPICIOUS_EMAIL_PREFIXES = [
    'info@', 'contact@', 'support@', 'sales@', 'admin@', 'hello@', 'office@', 'business@'
]

# Personal email domains (HIGHEST priority)
PERSONAL_EMAIL_DOMAINS = ['gmail.com', 'hotmail.com', 'outlook.com', 'live.com', 'yahoo.com', 'aol.com', 'protonmail.com']

# Minimum reviews
MIN_REVIEWS = 20

def clean_email(email):
    """Clean email from URL encoding and special characters."""
    if not email:
        return None
    import urllib.parse
    # Decode URL encoding
    email = urllib.parse.unquote(email)
    # Remove invisible Unicode characters
    email = email.replace('\u200b', '')  # Zero-width space
    email = email.replace('\ufeff', '')  # BOM
    email = email.strip()
    return email if '@' in email else None

def is_placeholder_email(email):
    """Check if email is a true placeholder (not a real business email)."""
    if not email:
        return False
    lower_email = email.lower()
    for pattern in PLACEHOLDER_EMAIL_PATTERNS:
        if pattern in lower_email:
            return True
    return False

def is_franchise(name, website, about):
    """Check if business is a franchise or large chain."""
    combined = f"{name} {website} {about}".lower()
    for keyword in FRANCHISE_KEYWORDS:
        if keyword in combined:
            return True
    return False

def is_wrong_niche(name, about, website, services):
    """Check if business is in wrong niche (insurance, retail, etc.)."""
    combined = f"{name} {about} {website} {services}".lower()
    for keyword in WRONG_NICHE_KEYWORDS:
        if keyword in combined:
            return True
    return False

def contains_exclude_keyword(text):
    """Check if text contains any exclude keywords."""
    if not text:
        return False
    lower_text = text.lower()
    for keyword in EXCLUDE_KEYWORDS:
        if keyword in lower_text:
            return True
    return False

def is_emergency_service(text):
    """Check if text suggests an emergency service business."""
    if not text:
        return False
    lower_text = text.lower()
    for keyword in EMERGENCY_KEYWORDS:
        if keyword in lower_text:
            return True
    return False

def is_open_24_hours(hours_text):
    """Check if business is open 24 hours (for emergency services)."""
    if not hours_text:
        return False
    return 'open 24 hours' in hours_text.lower() or 'open 24/7' in hours_text.lower()

def get_email_priority(email, tech_stack, name):
    """Determine email priority based on email type and tech stack."""
    if not email:
        return 'LOW', '❌'
    
    domain = email.split('@')[-1].lower() if '@' in email else ''
    local_part = email.split('@')[0].lower() if '@' in email else ''
    
    # TIER 1: Personal emails (highest reply rate) - goes directly to owner's phone
    if domain in PERSONAL_EMAIL_DOMAINS:
        if tech_stack and any(ts in tech_stack.lower() for ts in ['workiz', 'servicetitan', 'jobber', 'housecall']):
            return 'TIER_1', '⭐⭐⭐'
        return 'TIER_1', '⭐⭐'
    
    # TIER 2: Named business emails - goes to a specific person, not a generic inbox
    # Check if owner's name is in the email
    name_parts = name.lower().split() if name else []
    for part in name_parts:
        if len(part) > 2 and part in local_part:
            return 'TIER_2', '⭐⭐'
    
    # Short, specific contact patterns (likely to reach decision makers)
    # These are shorter than typical generic emails and suggest a specific person
    named_specific = ['schedule', 'team', 'cs', 'tampa', 'hvac']
    for pattern in named_specific:
        if pattern in local_part and len(local_part) < 12:
            return 'TIER_2', '⭐⭐'
    
    # TIER 3: Generic business emails - might hit a front desk or shared inbox
    # info@, support@, contact@, sales@, service@, office@, etc.
    return 'TIER_3', '⭐'

def filter_lead(row):
    """
    Apply all filters to a single lead.
    Returns (passes: bool, reason: str)
    """
    name = row.get('name', '')
    category = row.get('category', '')
    about = row.get('about', '')
    services = row.get('services', '')
    email = clean_email(row.get('email', ''))  # Clean email
    hours = row.get('hours', '')
    review_count_str = row.get('review_count', '0')
    tech_stack = row.get('tech_stack', '')
    website = row.get('website', '')
    
    # Store cleaned email back in row for later use
    row['email'] = email
    
    # Combine text fields for keyword checking
    combined_text = f"{name} {category} {about} {services} {website}".lower()
    
    # Filter 0: Franchise check
    if is_franchise(name, website, about):
        return False, f"FRANCHISE: {name}"
    
    # Filter 0b: Wrong niche check
    if is_wrong_niche(name, about, website, services):
        return False, f"WRONG NICHE: {name}"
    
    # Filter 1: Review count
    try:
        review_count = int(review_count_str.replace(',', '')) if review_count_str else 0
    except:
        review_count = 0
    
    if review_count < MIN_REVIEWS:
        return False, f"review_count={review_count} < {MIN_REVIEWS}"
    if review_count > 800:
        return False, f"review_count={review_count} > 800 (too big)"
    
    # Filter 2: Email check
    if not email or email.strip() == '':
        return False, "email is missing"
    
    if is_placeholder_email(email):
        return False, f"placeholder email: {email}"
    
    # Filter 3: Category/About exclusion keywords
    if contains_exclude_keyword(combined_text):
        return False, f"excluded keyword found in: {name}"
    
    # Filter 4: Hours check (must be open 24 hours for emergency services)
    if not is_open_24_hours(hours):
        return False, "not open 24 hours"
    
    return True, "PASSED"

def process_csv(input_file, output_file, rejected_file=None):
    """Process the CSV and filter leads based on ICP criteria."""
    qualified = []
    rejected = []
    
    # Use utf-8-sig to handle BOM in CSV files
    with open(input_file, 'r', encoding='utf-8-sig') as f:
        reader = csv.DictReader(f)
        fieldnames = list(reader.fieldnames) + ['priority', 'priority_stars', 'filter_reason', 'city']
        
        for row in reader:
            passes, reason = filter_lead(row)
            
            # Extract city from address
            address = row.get('address', '')
            city = 'Miami'  # Default
            city_match = re.search(r'Miami|Tampa|Orlando|Jacksonville|Fort Lauderdale', address, re.IGNORECASE)
            if city_match:
                city = city_match.group()
            
            # Determine priority (now includes name for named email detection)
            email = row.get('email', '')
            tech_stack = row.get('tech_stack', '')
            name = row.get('name', '')
            priority, stars = get_email_priority(email, tech_stack, name)
            
            # Add derived fields
            row['filter_reason'] = reason
            row['city'] = city
            row['priority'] = priority
            row['priority_stars'] = stars
            
            if passes:
                qualified.append(row)
            else:
                rejected.append(row)
    
    # Sort qualified leads by priority (TIER_1 > TIER_2 > TIER_3)
    priority_order = {'TIER_1': 0, 'TIER_2': 1, 'TIER_3': 2, 'LOW': 3}
    qualified.sort(key=lambda x: (priority_order.get(x.get('priority', 'TIER_3'), 3), -int(x.get('review_count', 0))))
    
    # Write qualified leads
    if qualified:
        with open(output_file, 'w', encoding='utf-8', newline='') as f:
            writer = csv.DictWriter(f, fieldnames=qualified[0].keys())
            writer.writeheader()
            writer.writerows(qualified)
    
    # Write rejected leads (for audit)
    if rejected_file and rejected:
        with open(rejected_file, 'w', encoding='utf-8', newline='') as f:
            writer = csv.DictWriter(f, fieldnames=rejected[0].keys())
            writer.writeheader()
            writer.writerows(rejected)
    
    return qualified, rejected

def generate_email_variables(lead):
    """Extract email template variables from a lead."""
    name = lead.get('name', '')
    review_count = lead.get('review_count', '0')
    city = lead.get('city', 'Miami')
    tech_stack = lead.get('tech_stack', '')
    hours = '24/7' if 'open 24 hours' in lead.get('hours', '').lower() else ''
    email = lead.get('email', '')
    phone = lead.get('phone', '')
    website = lead.get('website', '')
    
    # Detect service type from name/about
    about = lead.get('about', '').lower()
    name_lower = name.lower()
    
    if 'door' in name_lower or 'garage' in name_lower:
        service = 'garage door repair'
    elif 'ac' in name_lower or 'hvac' in name_lower or 'cooling' in about or 'ac repair' in about:
        service = 'AC repair'
    elif 'plumb' in name_lower:
        service = 'plumbing repair'
    elif 'electric' in name_lower:
        service = 'electrical repair'
    elif 'lock' in name_lower:
        service = 'locksmith service'
    elif 'water' in name_lower or 'flood' in name_lower:
        service = 'water damage restoration'
    elif 'roof' in name_lower:
        service = 'roof leak repair'
    elif 'appliance' in name_lower:
        service = 'appliance repair'
    else:
        service = 'home repair'
    
    return {
        'name': name,
        'review_count': review_count,
        'city': city,
        'service': service,
        'hours': hours,
        'tech_stack': tech_stack,
        'email': email,
        'phone': phone,
        'website': website
    }

def generate_templates(lead):
    """Generate personalized email templates for a lead."""
    vars = generate_email_variables(lead)
    
    templates = {
        'tech_stack': f'''Subject: Quick question for {vars['name']}

Hey Team,

I saw you guys have {vars['review_count']} reviews in {vars['city']} and you're open 24/7 for emergency {vars['service']}.

Since you're running on {vars['tech_stack']}, you clearly take operations seriously. Quick question: when a customer texts you at 11 PM about a broken {vars['service']}, who replies to them while your tech is already out on a call?

I built an AI assistant that texts them back instantly, gets their address and issue, and books them directly into your {vars['tech_stack']} calendar so you never lose a late-night job to a competitor.

I'm 19 and looking for 3 local businesses to set this up completely free for 30 days. No credit card.

Open to trying it?

— [Your Name]''',

        'ac_hvac': f'''Subject: Quick question for {vars['name']}

Hey Team,

I saw you guys handle {vars['service']} in {vars['city']} and you're open almost 24/7.

In Florida heat, when a customer's AC breaks at 2 PM and they text you while your tech is already on 3 jobs, who replies? Because if they don't hear back in 5 minutes, they're calling the next guy on Google.

I built an AI assistant that texts them back instantly, gets their details, and books them into your calendar automatically.

I'm 19, looking for 3 local businesses to test this completely free for 30 days. No card needed.

Open to trying it?

— [Your Name]''',

        'general': f'''Subject: Quick question for {vars['name']}

Hey Team,

I saw you guys are open 24/7 for home services in {vars['city']} with {vars['review_count']} reviews.

When a customer texts you for an urgent job at midnight while your guys are slammed, who handles that reply?

I built an AI assistant that responds instantly, qualifies the lead, and books them into your calendar so you never miss a job because you were too busy on another one.

Free for 30 days. No credit card. I'm 19 and just need 3 businesses to test this.

Open to it?

— [Your Name]'''
    }
    
    return templates

if __name__ == '__main__':
    import os
    import argparse
    
    parser = argparse.ArgumentParser(description='ReplyzeAI ICP Filter')
    parser.add_argument('--input', '-i', default='/workspace/ReplyzeAI_leads_2026-06-05_13-08.csv', help='Input CSV file')
    parser.add_argument('--output', '-o', default='/workspace/qualified_leads_tampa.csv', help='Output CSV file')
    parser.add_argument('--rejected', '-r', default='/workspace/rejected_leads_tampa.csv', help='Rejected leads CSV file')
    args = parser.parse_args()
    
    input_file = args.input
    output_file = args.output
    rejected_file = args.rejected
    
    print("=" * 60)
    print("ReplyzeAI ICP Filter - Emergency Services Focus")
    print("=" * 60)
    print(f"Input: {input_file}")
    print()
    
    qualified, rejected = process_csv(input_file, output_file, rejected_file)
    
    print(f"📊 FILTER RESULTS")
    print(f"   Total leads: {len(qualified) + len(rejected)}")
    print(f"   ✅ Qualified: {len(qualified)}")
    print(f"   ❌ Rejected: {len(rejected)}")
    print()
    
    if rejected:
        print("REJECTION BREAKDOWN:")
        reasons = {}
        for lead in rejected:
            reason = lead.get('filter_reason', 'unknown')
            reasons[reason] = reasons.get(reason, 0) + 1
        for reason, count in sorted(reasons.items(), key=lambda x: -x[1]):
            print(f"   • {reason}: {count}")
        print()
    
    if qualified:
        # Group by tier
        tier_1 = [l for l in qualified if l.get('priority') == 'TIER_1']
        tier_2 = [l for l in qualified if l.get('priority') == 'TIER_2']
        tier_3 = [l for l in qualified if l.get('priority') == 'TIER_3']
        
        print("=" * 60)
        print("📧 SENDING TIERS")
        print("=" * 60)
        
        if tier_1:
            print(f"\n⭐⭐⭐ TIER 1 - PERSONAL EMAILS (Send First - {len(tier_1)} leads)")
            print("-" * 50)
            for lead in tier_1:
                print(f"   {lead.get('email', 'N/A')} - {lead.get('name', 'Unknown')} ({lead.get('review_count', 0)} reviews)")
        
        if tier_2:
            print(f"\n⭐⭐ TIER 2 - NAMED BUSINESS EMAILS ({len(tier_2)} leads)")
            print("-" * 50)
            for lead in tier_2:
                print(f"   {lead.get('email', 'N/A')} - {lead.get('name', 'Unknown')} ({lead.get('review_count', 0)} reviews)")
        
        if tier_3:
            print(f"\n⭐ TIER 3 - GENERIC BUSINESS EMAILS ({len(tier_3)} leads)")
            print("-" * 50)
            for lead in tier_3:
                print(f"   {lead.get('email', 'N/A')} - {lead.get('name', 'Unknown')} ({lead.get('review_count', 0)} reviews)")
        
        print("\n" + "=" * 60)
        print(f"✅ Qualified leads saved to: {output_file}")
        print(f"❌ Rejected leads saved to: {rejected_file}")
    else:
        print("⚠️  No leads passed the filter!")
        print("\n💡 TIP: Your scraper may need to target emergency services:")
        print("   - Emergency plumber")
        print("   - AC repair / HVAC repair")
        print("   - Garage door repair")
        print("   - Water damage restoration")
        print("   - Electrical repair")
        print("   - Locksmith")